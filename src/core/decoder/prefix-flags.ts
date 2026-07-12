import type { InstructionPrefixes } from "#core/instructions/spec.js";

export const prefixFlagBits = {
  operandSizeOverride: 1 << 0,
  rep: 1 << 1,
  repne: 1 << 2
} as const;

export const prefixFlagMask =
  prefixFlagBits.operandSizeOverride | prefixFlagBits.rep | prefixFlagBits.repne;
export const prefixFlagBucketCount = prefixFlagMask + 1;

export function prefixFlagsFor(prefixes: InstructionPrefixes | undefined): number {
  let flags = prefixes?.operandSize === "override" ? prefixFlagBits.operandSizeOverride : 0;

  switch (prefixes?.rep) {
    case undefined:
      return flags;
    case "rep":
      flags |= prefixFlagBits.rep;
      return flags;
    case "repne":
      flags |= prefixFlagBits.repne;
      return flags;
  }
}
