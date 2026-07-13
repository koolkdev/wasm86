import type { IsaDecodedBlock } from "#core/decoder/decode-block.js";
import { u32 } from "#core/numeric.js";
import { wasmImport } from "#wasm/abi.js";
import { UnsupportedWasmCodegenError } from "#wasm/errors.js";
import { decodeExit, type DecodedExit } from "#wasm/exit.js";
import { buildIrBlock } from "./action-compiler.js";
import {
  jitModuleLinkTargets,
  encodeJitModule,
  jitBlockExportName,
  type JitBlock
} from "./module.js";
import {
  jitModuleLinkFallbackExportName,
  JitModuleLinkTable
} from "./compiled-blocks/module-link-table.js";

export type WasmBlockRun = Readonly<{
  exit: DecodedExit;
}>;

export type WasmBlockHandle = Readonly<{
  run(eip?: number): WasmBlockRun;
}>;

export type CompileWasmBlockHandleOptions = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function compileActionWasmBlockHandle(
  blocks: readonly IsaDecodedBlock[],
  options: CompileWasmBlockHandleOptions
): WasmBlockHandle {
  assertCompilableBlocks(blocks);

  const moduleBlocks: JitBlock[] = blocks.map((block) => ({
    entryEip: u32(block.startEip),
    ir: buildIrBlock(block.instructions)
  }));
  const targetEips = jitModuleLinkTargets(moduleBlocks);
  const moduleLinkTable = targetEips.length === 0 ? undefined : new JitModuleLinkTable({ targetEips });
  const bytes = encodeJitModule(
    moduleBlocks,
    moduleLinkTable === undefined ? {} : { linkLayout: moduleLinkTable.linkLayout() }
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
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, wasmImports(options.cpuStateMemory, options.guestMemory, moduleLinkTable));
  installModuleLocalFallbacks(instance, moduleLinkTable);
  const exportedBlockFunctions = readExportedBlockFunctions(instance, entryEips);

  return {
    run: (eip) => runWasmBlock(runTargetFunction(exportedBlockFunctions, entryEips, eip))
  };
}

function runWasmBlock(exportedBlockFunction: () => unknown): WasmBlockRun {
  const encodedExit = exportedBlockFunction();

  if (typeof encodedExit !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof encodedExit}`);
  }

  return {
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
  cpuStateMemory: WebAssembly.Memory,
  guestMemory: WebAssembly.Memory,
  moduleLinkTable: JitModuleLinkTable | undefined
): WebAssembly.Imports {
  return {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuStateMemory,
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
