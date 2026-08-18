import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/function/storage.js";

const resourceByteLength = 0x1_0000_0000;

export function validateStorageEffectRanges(effects: StorageEffects, label: string): void {
  validateAccessRanges(effects.reads, "read", label);
  validateAccessRanges(effects.writes, "write", label);
}

function validateAccessRanges(
  accesses: readonly StorageAccess[],
  direction: "read" | "write",
  label: string
): void {
  for (const [index, access] of accesses.entries()) {
    if (access.kind !== "resource" || access.range.kind === "whole") {
      continue;
    }
    const rangeLabel = `${label} ${direction} effect ${index}`;

    assert(
      Number.isInteger(access.range.byteOffset) && access.range.byteOffset >= 0,
      `${rangeLabel} slice byte offset must be a non-negative integer, got ${access.range.byteOffset}`
    );
    assert(
      Number.isInteger(access.range.byteLength) && access.range.byteLength > 0,
      `${rangeLabel} range byte length must be a positive integer, got ${access.range.byteLength}`
    );
    assert(
      access.range.byteOffset + access.range.byteLength <= resourceByteLength,
      `${rangeLabel} range end must not exceed 2^32 bytes`
    );
  }
}
