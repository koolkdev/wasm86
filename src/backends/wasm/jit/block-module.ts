import { u32 } from "#x86/numeric.js";
import { wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import { jitModuleLinkFallbackExportName } from "./compiled-blocks/module-link-table.js";
import { buildJitCodegenEmissionPlan } from "./codegen/plan/emission.js";
import {
  type JitLinkEmitContext,
  type JitLinkResolver
} from "./codegen/emit/control-actions.js";
import { createExitFrame, createExitStoreLayout } from "./codegen/emit/exit-frame.js";
import { createExitMetadataEmitter } from "./codegen/emit/exit-metadata.js";
import { createExitStoreEmitter } from "./codegen/emit/exit-stores.js";
import { createValueCache } from "./codegen/emit/cache.js";
import { createScheduleEmitter } from "./codegen/emit/schedule.js";
import { createInputSlotEmitter } from "./codegen/emit/input-slots.js";
import {
  createValueEmitters,
  unavailableLoadResultEmitter
} from "./codegen/emit/values.js";
import type { JitCodegenPlan } from "./codegen/plan/types.js";

export type EncodeJitBlockOptions = Readonly<{
  linkResolver?: JitLinkResolver;
}>;

export type JitBlockModulePlan = Readonly<{
  entryEip: number;
  plan: JitCodegenPlan;
}>;

export function encodeJitBlock(
  entries: readonly JitBlockModulePlan[],
  options: EncodeJitBlockOptions = {}
): Uint8Array<ArrayBuffer> {
  if (entries.length === 0) {
    throw new Error("cannot encode empty JIT IR block module");
  }

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

    const body = encodeJitBlockFunctionBody(
      entry.plan,
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

function encodeJitBlockFunctionBody(
  codegenPlan: JitCodegenPlan,
  linking?: JitLinkEmitContext
): WasmFunctionBodyEncoder {
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const valueState = createValueCache(
    body,
    emissionPlan.reusePlan.cache,
    emissionPlan.reusePlan.block
  );
  const values = createValueEmitters({
    body,
    cache: valueState.cache,
    scope: valueState.scope,
    inputs: createInputSlotEmitter(body),
    loadResults: unavailableLoadResultEmitter()
  });
  const metadata = createExitMetadataEmitter(body);
  const exitStores = createExitStoreEmitter({ body });
  const exitStoreLayout = createExitStoreLayout(emissionPlan.storeStrategy);
  const exitFrame = createExitFrame({
    body,
    metadata,
    stores: exitStores,
    layout: exitStoreLayout,
    exitLocal
  });

  metadata.beginBlock();
  exitFrame.openDeferredBlocks();

  const schedule = createScheduleEmitter({
    body,
    scratch,
    exitFrame,
    captures: emissionPlan.reusePlan.captures,
    values,
    linking
  });

  for (const entry of emissionPlan.schedule) {
    schedule.emit(entry);
  }

  scratch.assertClear();

  exitFrame.emitDeferredReturns();
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

function blockFunctionIndicesForEntries(
  entries: readonly JitBlockModulePlan[],
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
