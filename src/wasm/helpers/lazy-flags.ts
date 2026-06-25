import { assert } from "#common/assert.js";
import type { HelperCallKey } from "#ir/values.js";
import { flagChannel } from "#ir/slots.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { emitSlotLoad } from "#wasm/emit/state.js";
import type { HelperRegistry } from "./registry.js";

export type LazyFlagHelper = X86StatusFlag;

export function lazyFlagHelperKey(flag: LazyFlagHelper): HelperCallKey {
  return { kind: "lazyFlag", flag };
}

export function lazyFlagHelperName(flag: LazyFlagHelper): string {
  return `resolve${flag}`;
}

export function defineLazyFlagHelper(registry: HelperRegistry<HelperCallKey>, flag: LazyFlagHelper): number {
  return registry.define(lazyFlagHelperKey(flag), () => encodeLazyFlagHelperBody(flag));
}

export function defineLazyFlagHelpers(
  registry: HelperRegistry<HelperCallKey>,
  flags: Iterable<LazyFlagHelper>
): void {
  const required = new Set(flags);

  for (const flag of x86StatusFlags) {
    if (required.has(flag)) {
      defineLazyFlagHelper(registry, flag);
    }
  }
}

function encodeLazyFlagHelperBody(helper: LazyFlagHelper): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder();

  emitSlotLoad(body, flagChannel(helper), false, () => {
    assert(false, `${lazyFlagHelperName(helper)} unexpectedly needed a value operand`);
  });
  return body.end();
}
