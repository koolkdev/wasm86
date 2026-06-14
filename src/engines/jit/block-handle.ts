import type { IsaDecodedBlock } from "#x86/decoder/decode-block.js";
import { u32 } from "#x86/numeric.js";
import { wasmImport } from "#wasm/abi.js";
import { UnsupportedWasmCodegenError } from "#wasm/errors.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { buildIrBlock } from "./action-compiler.js";
import {
  actionJitModuleLinkTargets,
  encodeActionJitModule,
  jitBlockExportName,
  type ActionJitBlock
} from "./action-module.js";
import {
  jitModuleLinkFallbackExportName,
  JitModuleLinkTable
} from "./compiled-blocks/module-link-table.js";

export const wasmBlockExitEncoding = {
  resultType: "i64",
  payloadBits: "0..31",
  exitReasonBits: "32..47",
  reservedBits: "48..63"
} as const;

export type WasmBlockExitEncoding = typeof wasmBlockExitEncoding;

export type WasmBlockMetadata = Readonly<{
  blockCount: number;
  instructionCount: number;
  wasmByteLength: number;
  exitEncoding: WasmBlockExitEncoding;
}>;

export type WasmBlockRun = Readonly<{
  encodedExit: bigint;
  exit: DecodedExit;
}>;

export type WasmBlockHandle = Readonly<{
  entryEips: readonly number[];
  entryEip?: number;
  blockKey?: WasmBlockKey;
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  exportedBlockFunctions: ReadonlyMap<number, () => unknown>;
  exportedBlockFunction?: () => unknown;
  moduleLinkTable?: JitModuleLinkTable;
  compileMs: number;
  instantiateMs: number;
  metadata: WasmBlockMetadata;
  exportedBlockFunctionForEip(eip: number): () => unknown;
  run(eip?: number): WasmBlockRun;
}>;

export type WasmBlockKey = number;

export type CompileWasmBlockHandleOptions = Readonly<{
  stateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  blockKey?: WasmBlockKey;
}>;

export function compileActionWasmBlockHandle(
  blocks: readonly IsaDecodedBlock[],
  options: CompileWasmBlockHandleOptions
): WasmBlockHandle {
  assertCompilableBlocks(blocks);

  const moduleBlocks: ActionJitBlock[] = blocks.map((block) => ({
    entryEip: u32(block.startEip),
    actions: buildIrBlock(block.instructions)
  }));
  const targetEips = actionJitModuleLinkTargets(moduleBlocks);
  const moduleLinkTable = targetEips.length === 0 ? undefined : new JitModuleLinkTable({ targetEips });
  const bytes = encodeActionJitModule(
    moduleBlocks,
    moduleLinkTable === undefined ? {} : { moduleLinkTable }
  );

  return instantiateCompiledBlocks(blocks, bytes, moduleLinkTable, options);
}

function assertCompilableBlocks(blocks: readonly IsaDecodedBlock[]): void {
  if (blocks.length === 0) {
    throw new UnsupportedWasmCodegenError("cannot compile empty block module");
  }

  for (const block of blocks) {
    if (block.instructions.length === 0) {
      throw new UnsupportedWasmCodegenError(unsupportedBlockMessage(block));
    }
  }
}

function instantiateCompiledBlocks(
  blocks: readonly IsaDecodedBlock[],
  bytes: Uint8Array<ArrayBuffer>,
  moduleLinkTable: JitModuleLinkTable | undefined,
  options: CompileWasmBlockHandleOptions
): WasmBlockHandle {
  const entryEips = blocks.map((block) => u32(block.startEip));
  const compileStart = performance.now();
  const module = new WebAssembly.Module(bytes);
  const compileMs = performance.now() - compileStart;
  const instantiateStart = performance.now();
  const instance = new WebAssembly.Instance(module, wasmImports(options.stateMemory, options.guestMemory, moduleLinkTable));
  const instantiateMs = performance.now() - instantiateStart;
  installModuleLocalFallbacks(instance, moduleLinkTable);
  const exportedBlockFunctions = readExportedBlockFunctions(instance, entryEips);
  const soleBlockFunction = entryEips.length === 1 ? requiredBlockFunction(exportedBlockFunctions, entryEips[0]!) : undefined;

  return {
    entryEips,
    ...(entryEips.length === 1 ? { entryEip: entryEips[0]!, blockKey: options.blockKey ?? entryEips[0]! } : {}),
    module,
    instance,
    exportedBlockFunctions,
    ...(soleBlockFunction === undefined ? {} : { exportedBlockFunction: soleBlockFunction }),
    ...(moduleLinkTable === undefined ? {} : { moduleLinkTable }),
    compileMs,
    instantiateMs,
    metadata: {
      blockCount: blocks.length,
      instructionCount: blocks.reduce((sum, block) => sum + block.instructions.length, 0),
      wasmByteLength: bytes.byteLength,
      exitEncoding: wasmBlockExitEncoding
    },
    exportedBlockFunctionForEip: (eip) => requiredBlockFunction(exportedBlockFunctions, eip),
    run: (eip) => runWasmBlock(runTargetFunction(exportedBlockFunctions, entryEips, eip))
  };
}

function runWasmBlock(exportedBlockFunction: () => unknown): WasmBlockRun {
  const encodedExit = exportedBlockFunction();

  if (typeof encodedExit !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof encodedExit}`);
  }

  return {
    encodedExit,
    exit: decodeExit(encodedExit)
  };
}

function installModuleLocalFallbacks(
  instance: WebAssembly.Instance,
  moduleLinkTable: JitModuleLinkTable | undefined
): void {
  if (moduleLinkTable === undefined) {
    return;
  }

  for (const targetEip of moduleLinkTable.targetEips()) {
    moduleLinkTable.installModuleLocalFallback(
      targetEip,
      readExportedFunction(instance, jitModuleLinkFallbackExportName(targetEip))
    );
  }
}

function wasmImports(
  stateMemory: WebAssembly.Memory,
  guestMemory: WebAssembly.Memory,
  moduleLinkTable: JitModuleLinkTable | undefined
): WebAssembly.Imports {
  return {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory,
      ...(moduleLinkTable === undefined ? {} : { [wasmImport.linkTableName]: moduleLinkTable.table })
    }
  };
}

function readExportedBlockFunctions(
  instance: WebAssembly.Instance,
  entryEips: readonly number[]
): ReadonlyMap<number, () => unknown> {
  const functions = new Map<number, () => unknown>();

  for (const entryEip of entryEips) {
    functions.set(u32(entryEip), readExportedFunction(instance, jitBlockExportName(entryEip)));
  }

  return functions;
}

function runTargetFunction(
  functions: ReadonlyMap<number, () => unknown>,
  entryEips: readonly number[],
  eip: number | undefined
): () => unknown {
  if (eip !== undefined) {
    return requiredBlockFunction(functions, eip);
  }

  if (entryEips.length !== 1) {
    throw new Error("multi-block Wasm module run requires an explicit EIP");
  }

  return requiredBlockFunction(functions, entryEips[0]!);
}

function requiredBlockFunction(functions: ReadonlyMap<number, () => unknown>, eip: number): () => unknown {
  const entryEip = u32(eip);
  const fn = functions.get(entryEip);

  if (fn === undefined) {
    throw new Error(`missing exported JIT block function for 0x${entryEip.toString(16)}`);
  }

  return fn;
}

function readExportedFunction(instance: WebAssembly.Instance, name: string): () => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as () => unknown;
}

function unsupportedBlockMessage(block: IsaDecodedBlock): string {
  switch (block.terminator.kind) {
    case "unsupported":
      return `unsupported x86 opcode at 0x${block.terminator.address.toString(16)}`;
    case "decode-fault":
      return `decode fault at 0x${block.terminator.fault.address.toString(16)}`;
    default:
      return `cannot compile empty block at 0x${block.startEip.toString(16)}`;
  }
}
