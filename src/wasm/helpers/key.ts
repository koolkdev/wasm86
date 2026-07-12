import type { X86StatusFlag } from "#core/flags.js";

export type HelperCallKey = Readonly<{
  kind: "lazyFlag";
  flag: X86StatusFlag;
}>;

export function lazyFlagHelperName(flag: X86StatusFlag): string {
  return `resolve${flag}`;
}

export function helperFunctionName(helper: HelperCallKey): string {
  return lazyFlagHelperName(helper.flag);
}
