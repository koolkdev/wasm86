import type { Action, OpAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { walkBodyActions } from "#ir/traverse.js";
import { x86StatusFlags } from "#core/flags.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#compiler/encoder/types.js";
import {
  opActionMustExecute,
  type BlockLiveness
} from "#wasm/emit/liveness.js";
import {
  encodeLazyFlagHelperBody
} from "./lazy-flags.js";
import { helperFunctionName, type HelperCallKey } from "./key.js";
import {
  LegacyHelperIndexRegistryAdapter,
  type LegacyHelperIndexBinding
} from "./registry.js";

export const helperFunctionType = {
  params: [],
  results: [wasmValueType.i32]
} as const satisfies WasmFunctionType;

const knownHelpers: readonly HelperCallKey[] = x86StatusFlags.map((flag) => ({ kind: "lazyFlag", flag }));

export function allHelpers(): readonly HelperCallKey[] {
  return knownHelpers;
}

// Canonicalizes discovery results before either declaring raw helper factories
// in a closed program or installing them in a still-direct legacy module.
export function orderedHelpers(helpers: Iterable<HelperCallKey>): readonly HelperCallKey[] {
  const required = new Set<string>();

  for (const helper of helpers) {
    required.add(helperFunctionName(helper));
  }

  return knownHelpers.filter((helper) => required.has(helperFunctionName(helper)));
}

export function encodeHelperBody(helper: HelperCallKey): EncodedWasmFunctionBody {
  switch (helper.kind) {
    case "lazyFlag":
      return encodeLazyFlagHelperBody(helper.flag);
  }
}

// Direct legacy modules still need numeric functions today. Module mutation
// and raw body creation happen here, before the numeric-only adapter exists.
export function installHelpers(
  module: WasmModuleEncoder,
  helpers: Iterable<HelperCallKey>
): LegacyHelperIndexRegistryAdapter {
  const ordered = orderedHelpers(helpers);

  if (ordered.length === 0) {
    return new LegacyHelperIndexRegistryAdapter([]);
  }

  const typeIndex = module.addFunctionType(helperFunctionType);
  const bindings = ordered.map((key): LegacyHelperIndexBinding => ({
    key,
    functionIndex: module.addFunction(typeIndex, encodeHelperBody(key))
  }));

  return new LegacyHelperIndexRegistryAdapter(bindings);
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
