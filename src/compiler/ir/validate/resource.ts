import { assert } from "#common/assert.js";
import {
  DynamicByteOriginRef,
  type ByteRange,
  type ResourceEffect,
  type ResourceReadMode
} from "#compiler/ir/resource.js";
import type { ResourceOperation } from "#compiler/ir/operations/resource.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { WidthBounds } from "#compiler/ir/values/types.js";

const resourceByteLength = 0x1_0000_0000;

export function validateResourceOperation(
  operation: ResourceOperation,
  path: string
): void {
  const label = `${path} ${operation.kind}`;
  const operand = operation.kind === "resource.read"
    ? operation.source
    : operation.destination;
  const { effect, width } = operand;
  const displacement = operand.address.displacement;

  assert(
    width === 8 || width === 16 || width === 32,
    `${label} width must be 8, 16, or 32, got ${String(width)}`
  );
  assert(
    Number.isInteger(displacement) &&
      displacement >= 0 &&
      displacement <= 0xffff_ffff,
    `${label} address displacement must be an unsigned 32-bit integer, got ${displacement}`
  );
  validateResourceEffect(effect, label);

  if (effect.range.slice !== undefined) {
    const transferByteLength = width / 8;

    assert(
      effect.range.slice.byteLength >= transferByteLength,
      `${label} range byte length ${effect.range.slice.byteLength} must contain its ${width}-bit transfer`
    );
  }

  switch (operation.kind) {
    case "resource.read":
      validateReadMode(operation.mode, operation.source.width, label);
      return;
    case "resource.write":
      return;
  }
}

export function validateResourceEffect(effect: ResourceEffect, label: string): void {
  assert(effect !== undefined && effect !== null, `${label} is missing its resource effect`);
  assert(effect.space === "resource", `${label} effect must use resource space`);
  assert(
    effect.resource !== undefined &&
      effect.resource.kind === "resource" &&
      typeof effect.resource.id === "string" &&
      effect.resource.id.length > 0,
    `${label} effect has an invalid resource identity`
  );
  assert(effect.range !== undefined && effect.range !== null, `${label} is missing its byte range`);
  validateByteRange(effect.range, label);
}

function validateReadMode(
  mode: ResourceReadMode | undefined,
  width: 8 | 16 | 32,
  label: string
): void {
  assert(
    mode === undefined ||
      (mode !== null &&
        typeof mode === "object" &&
        (mode.kind === "signed" || mode.kind === "unsigned")),
    `${label} has an invalid read mode`
  );

  if (mode?.kind === "signed") {
    assert(
      width !== 32,
      `${label} signed mode is valid only for a narrow read`
    );
    return;
  }

  const refinement = mode?.bounds;

  if (refinement === undefined) {
    return;
  }

  assertValidBounds(refinement, label);
  const mechanical = width === 32
    ? { unsignedBits: 32, signedBits: 32 }
    : fitsUnsigned(width);

  assert(
    refinement.unsignedBits <= mechanical.unsignedBits &&
      refinement.signedBits <= mechanical.signedBits,
    `${label} refinement exceeds its mechanical load bounds`
  );
}

function assertValidBounds(bounds: WidthBounds, label: string): void {
  assert(
    Number.isInteger(bounds.unsignedBits) &&
      bounds.unsignedBits >= 0 &&
      bounds.unsignedBits <= 32 &&
      Number.isInteger(bounds.signedBits) &&
      bounds.signedBits >= 0 &&
      bounds.signedBits <= 32 &&
      bounds.signedBits <= bounds.unsignedBits + 1,
    `${label} result bounds are malformed`
  );
}

function validateByteRange(range: ByteRange, label: string): void {
  assert(range.basis !== undefined && range.basis !== null, `${label} range is missing its basis`);

  switch (range.basis.kind) {
    case "resource":
      break;
    case "dynamic":
      assert(
        range.basis.origin instanceof DynamicByteOriginRef,
        `${label} dynamic basis origin must be a DynamicByteOriginRef`
      );
      break;
    default:
      assert(false, `${label} range has an unknown basis`);
  }

  const slice = range.slice;

  if (slice === undefined) {
    return;
  }
  assert(slice !== null, `${label} range slice must be an object`);
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
