import { u32 } from "#x86/state/cpu-state.js";
import { wasmImport, wasmMemoryIndex } from "#backends/wasm/abi.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { encodeExit, ExitReason } from "#backends/wasm/exit.js";
import { jitModuleLinkFallbackExportName } from "./compiled-blocks/module-link-table.js";
import { validateJitIrBlock } from "./ir/validate.js";
import { buildJitCodegenEmissionPlan } from "./codegen/plan/emission.js";
import { planJitCodegen } from "./codegen/plan/plan.js";
import {
  emitJitIrWithContext,
  type JitLinkEmitContext,
  type JitLinkResolver
} from "./codegen/emit/ir-context.js";
import { createJitValueCacheRuntime } from "./codegen/emit/value-local-store.js";
import { optimizeJitIrBlock } from "./optimization/optimize.js";
import { createJitIrState, type JitExitTarget, type JitIrState } from "./state/state.js";
import type { JitIrBlock } from "./ir/types.js";

export type EncodeJitIrBlockOptions = Readonly<{
  linkResolver?: JitLinkResolver;
}>;

export function encodeJitIrBlock(
  blocks: readonly JitIrBlock[],
  options: EncodeJitIrBlockOptions = {}
): Uint8Array<ArrayBuffer> {
  if (blocks.length === 0) {
    throw new Error("cannot encode empty JIT IR block module");
  }

  const entries = blocks.map((block) => ({
    block,
    entryEip: entryEipForBlock(block)
  }));
  const targetEips = options.linkResolver?.moduleTable?.targetEips() ?? [];
  const blockFunctionIndices = blockFunctionIndicesForEntries(entries, targetEips);
  const module = new WasmModuleEncoder();
  const stateMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, { minPages: 1 });
  const linkTableIndex = targetEips.length === 0
    ? undefined
    : module.importTable(wasmImport.moduleName, wasmImport.linkTableName, {
        minElements: targetEips.length,
        maxElements: targetEips.length
      });

  if (stateMemoryIndex !== wasmMemoryIndex.state || guestMemoryIndex !== wasmMemoryIndex.guest) {
    throw new Error("unexpected Wasm memory import order");
  }

  const typeIndex = module.addFunctionType({
    params: [],
    results: [wasmValueType.i64]
  });
  emitLinkFallbackExports(module, typeIndex, targetEips);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) {
      throw new Error(`missing JIT block module entry: ${index}`);
    }

    const expectedFunctionIndex = blockFunctionIndices.get(entry.entryEip);

    if (expectedFunctionIndex === undefined) {
      throw new Error(`missing function index for JIT block 0x${entry.entryEip.toString(16)}`);
    }

    const body = encodeJitIrBlockFunctionBody(
      entry.block,
      linkingContext(
        {
          ...(options.linkResolver === undefined ? {} : options.linkResolver),
          functionIndexForStaticTarget: (eip) => blockFunctionIndices.get(u32(eip))
        },
        typeIndex,
        linkTableIndex
      )
    );
    const functionIndex = module.addFunction(typeIndex, body);

    if (functionIndex !== expectedFunctionIndex) {
      throw new Error(`unexpected JIT block function index: ${functionIndex} !== ${expectedFunctionIndex}`);
    }

    module.exportFunction(jitBlockExportName(entry.entryEip), functionIndex);
  }

  return module.encode();
}

export function jitBlockExportName(eip: number): string {
  return `block_${u32(eip).toString(16)}`;
}

function encodeJitIrBlockFunctionBody(
  block: JitIrBlock,
  linking?: JitLinkEmitContext
): WasmFunctionBodyEncoder {
  const optimizedBlock = optimizeJitIrBlock(block);
  const codegenPlan = planJitCodegen(optimizedBlock);

  validateJitIrBlock(optimizedBlock);

  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const valueCache = createJitValueCacheRuntime(body, emissionPlan.valueCachePlan);
  const state = createJitIrState(body, emissionPlan.exitMaterializations, { valueCache });
  const exit: JitExitTarget = { exitLocal, exitLabelDepth: state.maxExitMaterializationIndex };

  state.emitLoadInstructionCount();

  emitExitMaterializationBlocks(body, state.maxExitMaterializationIndex);
  emitJitIrWithContext({
    body,
    scratch,
    state,
    exit,
    instructions: emissionPlan.instructions,
    exitPoints: emissionPlan.exitPoints,
    valueCache,
    linking
  });
  emitExitMaterializationStores(body, state, exitLocal);
  scratch.assertClear();
  body.end();

  return body;
}

function linkingContext(
  resolver: JitLinkResolver | undefined,
  blockTypeIndex: number,
  tableIndex: number | undefined
): JitLinkEmitContext | undefined {
  if (resolver === undefined) {
    return undefined;
  }

  if (
    resolver.functionIndexForStaticTarget === undefined &&
    (resolver.slotForStaticTarget === undefined || tableIndex === undefined)
  ) {
    return undefined;
  }

  return {
    ...resolver,
    blockTypeIndex,
    ...(tableIndex === undefined ? {} : { tableIndex })
  };
}

type JitBlockModuleEntry = Readonly<{
  block: JitIrBlock;
  entryEip: number;
}>;

function entryEipForBlock(block: JitIrBlock): number {
  const instruction = block.instructions[0];

  if (instruction === undefined) {
    throw new Error("cannot encode empty JIT IR block in module");
  }

  return u32(instruction.eip);
}

function blockFunctionIndicesForEntries(
  entries: readonly JitBlockModuleEntry[],
  fallbackTargetEips: readonly number[]
): ReadonlyMap<number, number> {
  const indices = new Map<number, number>();
  let nextFunctionIndex = fallbackTargetEips.length;

  for (const entry of entries) {
    const entryEip = u32(entry.entryEip);

    if (indices.has(entryEip)) {
      throw new Error(`duplicate JIT block module entry EIP: 0x${entryEip.toString(16)}`);
    }

    indices.set(entryEip, nextFunctionIndex);
    nextFunctionIndex += 1;
  }

  return indices;
}

function emitExitMaterializationBlocks(body: WasmFunctionBodyEncoder, maxExitMaterializationIndex: number): void {
  for (let index = 0; index <= maxExitMaterializationIndex; index += 1) {
    void index;
    body.block();
  }
}

function emitLinkFallbackExports(
  module: WasmModuleEncoder,
  typeIndex: number,
  targetEips: readonly number[]
): void {
  for (const targetEip of targetEips) {
    const fallbackIndex = module.addFunction(
      typeIndex,
      new WasmFunctionBodyEncoder()
        .i64Const(encodeExit(ExitReason.JUMP, targetEip))
        .end()
    );

    module.exportFunction(jitModuleLinkFallbackExportName(targetEip), fallbackIndex);
  }
}

function emitExitMaterializationStores(
  body: WasmFunctionBodyEncoder,
  state: JitIrState,
  exitLocal: number
): void {
  for (let index = state.maxExitMaterializationIndex; index >= 0; index -= 1) {
    body.endBlock();
    state.emitExitMaterializationStores(index);
    body.localGet(exitLocal).returnFromFunction();
  }
}
