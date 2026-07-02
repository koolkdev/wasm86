import type { Action, OpAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { opMutates } from "#ir/ops.js";
import { walkBodyActions } from "#ir/traverse.js";
import { x86StatusFlags } from "#x86/flags.js";
import type { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#wasm/encoder/types.js";
import type { BlockValueAnalysis } from "#wasm/emit/values.js";
import {
  defineLazyFlagHelpers,
  lazyFlagHelperName,
  type HelperCallKey,
  type LazyFlagHelper
} from "./lazy-flags.js";
import { HelperRegistry } from "./registry.js";

export type WasmHelperRegistry = HelperRegistry<HelperCallKey>;

const helperFunctionType = {
  params: [],
  results: [wasmValueType.i32]
} as const satisfies WasmFunctionType;

const knownHelpers: readonly HelperCallKey[] = x86StatusFlags.map((flag) => ({ kind: "lazyFlag", flag }));

export function createWasmHelperRegistry(module: WasmModuleEncoder): WasmHelperRegistry {
  return new HelperRegistry(module, helperFunctionType, helperFunctionName);
}

export function allHelpers(): readonly HelperCallKey[] {
  return knownHelpers;
}

export function helperCallsForBlock(
  block: IrBlock,
  analysis: BlockValueAnalysis
): readonly HelperCallKey[] {
  const helperCalls = new Map<string, HelperCallKey>();

  walkBodyActions(block.body, (action) => {
    const helper = liveActionHelper(action, analysis);

    if (helper !== undefined) {
      helperCalls.set(helperFunctionName(helper), helper);
    }
  });

  return [...helperCalls.values()];
}

function liveActionHelper(
  action: Action,
  analysis: BlockValueAnalysis
): HelperCallKey | undefined {
  if (action.kind !== "op") {
    return undefined;
  }

  const helper = actionHelper(action);

  if (helper === undefined) {
    return undefined;
  }

  if (opMutates(action.op)) {
    return helper;
  }

  const output = action.output;

  return output !== undefined && analysis.useCount(output) > 0
    ? helper
    : undefined;
}

function actionHelper(action: OpAction): HelperCallKey | undefined {
  switch (action.op.kind) {
    case "cpu.resolveFlag":
      return { kind: "lazyFlag", flag: action.op.flag };
    case "state.read":
    case "state.write":
    case "memory.read":
    case "memory.write":
      return undefined;
  }
}

export function defineRequiredHelpers(
  registry: WasmHelperRegistry,
  helpers: Iterable<HelperCallKey>
): void {
  const lazyFlags: LazyFlagHelper[] = [];

  for (const helper of helpers) {
    switch (helper.kind) {
      case "lazyFlag":
        lazyFlags.push(helper.flag);
        break;
    }
  }

  defineLazyFlagHelpers(registry, lazyFlags);
}

export function defineAllHelpers(registry: WasmHelperRegistry): void {
  defineRequiredHelpers(registry, knownHelpers);
}

export function helperFunctionName(helper: HelperCallKey): string {
  switch (helper.kind) {
    case "lazyFlag":
      return lazyFlagHelperName(helper.flag);
  }
}
