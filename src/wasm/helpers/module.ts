import type { IrBlock } from "#ir/block.js";
import type { HelperCallKey } from "#ir/values.js";
import { x86StatusFlags } from "#x86/flags.js";
import type { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#wasm/encoder/types.js";
import type { BlockValueAnalysis } from "#wasm/emit/values.js";
import {
  defineLazyFlagHelpers,
  lazyFlagHelperName,
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

  for (let id = 0; id < block.values.size(); id += 1) {
    if (analysis.useCount(id) === 0) {
      continue;
    }

    const node = block.values.node(id);

    if (node.kind === "helperCall") {
      helperCalls.set(helperFunctionName(node.helper), node.helper);
    }
  }

  return [...helperCalls.values()];
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
