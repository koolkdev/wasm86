import type { X86StatusFlag } from "#core/flags/definitions.js";
import type { HelperCall } from "#compiler/ir/operations/definition.js";

export type HelperCallKey = HelperCall;

export function lazyFlagHelperName(flag: X86StatusFlag): string {
  return `resolve${flag}`;
}

export function helperFunctionName(helper: HelperCallKey): string {
  return lazyFlagHelperName(helper.flag);
}
