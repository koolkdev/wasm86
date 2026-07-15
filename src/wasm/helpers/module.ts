import type { BodyAnalysis } from "#compiler/analysis/model.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#compiler/encoder/types.js";
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

export function helperCallsForAnalysis(
  analysis: BodyAnalysis
): readonly HelperCallKey[] {
  const helpers: HelperCallKey[] = [];
  const seen = new Set<string>();

  for (const { action } of analysis.operations()) {
    if (!analysis.opActionMustExecute(action) || action.op.helper === undefined) {
      continue;
    }
    const name = helperFunctionName(action.op.helper);

    if (!seen.has(name)) {
      seen.add(name);
      helpers.push(action.op.helper);
    }
  }

  return helpers;
}
