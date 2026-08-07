import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/function/storage.js";
import type { ResourceOperation } from "#compiler/function/operation.js";
import type { ByteRange, ResourceEffect } from "#compiler/function/resource.js";

const resourceByteLength = 0x1_0000_0000;

export function validateStorageEffectRanges(effects: StorageEffects, label: string): void {
  validateAccessRanges(effects.reads, "read", label);
  validateAccessRanges(effects.writes, "write", label);
}

export function validateResourceOperation(operation: ResourceOperation, path: string): void {
  const label = `${path} ${operation.kind}`;
  const operand = operation.kind === "resource.read" ? operation.source : operation.destination;
  const { effect, width } = operand;
  const displacement = operand.address.displacement;

  assert(
    Number.isInteger(displacement) && displacement >= 0 && displacement <= 0xffff_ffff,
    `${label} address displacement must be an unsigned 32-bit integer, got ${displacement}`
  );

  if (effect.range.slice !== undefined) {
    const transferByteLength = width / 8;

    assert(
      effect.range.slice.byteLength >= transferByteLength,
      `${label} range byte length ${effect.range.slice.byteLength} must contain its ${width}-bit transfer`
    );
  }
}

function validateAccessRanges(
  accesses: readonly StorageAccess[],
  direction: "read" | "write",
  label: string
): void {
  for (const [index, access] of accesses.entries()) {
    if (access.space === "resource") {
      validateResourceEffectRange(access, `${label} ${direction} effect ${index}`);
    }
  }
}

function validateResourceEffectRange(effect: ResourceEffect, label: string): void {
  validateByteRange(effect.range, label);
}

function validateByteRange(range: ByteRange, label: string): void {
  const slice = range.slice;

  if (slice === undefined) {
    return;
  }
  assert(
    Number.isInteger(slice.byteOffset) && slice.byteOffset >= 0,
    `${label} slice byte offset must be a non-negative integer, got ${slice.byteOffset}`
  );
  assert(
    Number.isInteger(slice.byteLength) && slice.byteLength > 0,
    `${label} range byte length must be a positive integer, got ${slice.byteLength}`
  );
  assert(
    slice.byteOffset + slice.byteLength <= resourceByteLength,
    `${label} range end must not exceed 2^32 bytes`
  );
}
