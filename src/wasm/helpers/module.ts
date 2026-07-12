import type { Action, OpAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { walkBodyActions } from "#ir/traverse.js";
import { x86StatusFlags } from "#core/flags.js";
import type { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#compiler/encoder/types.js";
import {
  opActionMustExecute,
  type BlockLiveness
} from "#wasm/emit/liveness.js";
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
  liveness: BlockLiveness
): readonly HelperCallKey[] {
  const helperCalls = new Map<string, HelperCallKey>();

  walkBodyActions(block.body, (action) => {
    const helper = requiredActionHelper(action, liveness);

    if (helper !== undefined) {
      helperCalls.set(helperFunctionName(helper), helper);
    }
  });

  return [...helperCalls.values()];
}

function requiredActionHelper(
  action: Action,
  liveness: BlockLiveness
): HelperCallKey | undefined {
  if (action.kind !== "op") {
    return undefined;
  }

  const helper = actionHelper(action);

  if (helper === undefined) {
    return undefined;
  }

  return opActionMustExecute(action, liveness) ? helper : undefined;
}

function actionHelper(action: OpAction): HelperCallKey | undefined {
  switch (action.op.kind) {
    case "cpu.resolveFlag":
      return { kind: "lazyFlag", flag: action.op.flag };
    default:
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
