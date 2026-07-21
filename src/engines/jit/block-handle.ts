import { assert } from "#common/assert.js";
import { u32 } from "#core/numeric.js";
import { createInstructionConstruction } from "#core/instruction/builder.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { UnsupportedWasmCodegenError } from "#wasm/errors.js";
import { buildExit, decodeExit, exitLayout } from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import type { RunStop } from "#cpu/cpu.js";
import type { ExecutionModel } from "#execution/model.js";
import { buildIrBlock } from "./action-compiler.js";
import {
  jitModuleLinkTargets,
  encodeJitModule,
  jitBlockExportName,
  jitLinkTableImportName,
  type JitBlock
} from "./module.js";
import {
  jitModuleLinkFallbackExportName,
  JitModuleLinkTable
} from "./compiled-blocks/module-link-table.js";
import {
  decodeTransfer,
  transferByteLength,
  type LegacyTransfer
} from "./legacy-transfer.js";
import type { JitDecodedBlock } from "./decode-block.js";

assert(
  exitLayout.tagOffset >= transferByteLength,
  "Cpu exits overlap the legacy JIT transfer namespace"
);

export type WasmBlockRun = Readonly<{
  exit: LegacyTransfer | RunStop;
}>;

export type WasmBlockHandle = Readonly<{
  run(eip?: number): WasmBlockRun;
}>;

export type CompileWasmBlockHandleOptions = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function compileActionWasmBlockHandle(
  model: ExecutionModel,
  blocks: readonly JitDecodedBlock[],
  options: CompileWasmBlockHandleOptions
): WasmBlockHandle {
  assertCompilableBlocks(blocks);
  const instructionConstruction = createInstructionConstruction({
    stateAccess: model.cpuState.access,
    memory: model.guestMemory.access,
    instructionCountField,
    buildExit
  });

  const moduleBlocks: JitBlock[] = blocks.map((block) => ({
    entryEip: u32(block.startEip),
    ir: buildIrBlock(instructionConstruction, block.instructions)
  }));
  const targetEips = jitModuleLinkTargets(moduleBlocks);
  const moduleLinkTable = targetEips.length === 0 ? undefined : new JitModuleLinkTable({ targetEips });
  const bytes = encodeJitModule(
    model,
    moduleBlocks,
    moduleLinkTable === undefined ? {} : { linkLayout: moduleLinkTable.linkLayout() }
  );

  return instantiateCompiledBlocks(
    model,
    blocks,
    bytes,
    moduleLinkTable,
    options
  );
}

function assertCompilableBlocks(blocks: readonly JitDecodedBlock[]): void {
  if (blocks.length === 0) {
    throw new UnsupportedWasmCodegenError("cannot compile empty block module");
  }

  for (const block of blocks) {
    if (block.terminator.kind === "cpuException") {
      throw new UnsupportedWasmCodegenError(
        `raw JIT cannot lower decode-time ${block.terminator.exception.kind} at 0x${block.terminator.instructionStart.toString(16)}`
      );
    }

    if (block.instructions.length === 0) {
      throw new UnsupportedWasmCodegenError(
        `cannot compile empty block at 0x${block.startEip.toString(16)}`
      );
    }
  }
}

function instantiateCompiledBlocks(
  model: ExecutionModel,
  blocks: readonly JitDecodedBlock[],
  bytes: Uint8Array<ArrayBuffer>,
  moduleLinkTable: JitModuleLinkTable | undefined,
  options: CompileWasmBlockHandleOptions
): WasmBlockHandle {
  const entryEips = blocks.map((block) => u32(block.startEip));
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(
    module,
    wasmImports(
      model,
      options.cpuStateMemory,
      options.guestMemory,
      moduleLinkTable
    )
  );
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
    exit: decodeTransfer(encodedExit) ?? decodeExit(encodedExit)
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
  model: ExecutionModel,
  cpuStateMemory: WebAssembly.Memory,
  guestMemory: WebAssembly.Memory,
  moduleLinkTable: JitModuleLinkTable | undefined
): WebAssembly.Imports {
  return {
    [programImportModuleName]: {
      [model.cpuState.memoryImport.name]: cpuStateMemory,
      [model.guestMemory.memoryImport.name]: guestMemory,
      ...(moduleLinkTable === undefined
        ? {}
        : { [jitLinkTableImportName]: moduleLinkTable.table })
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
