import { assert } from "#common/assert.js";
import {
  DynamicByteOriginRef,
  type ByteRange,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import type { ResourceOperation } from "#compiler/ir/operations/resource.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { WidthBounds } from "#compiler/ir/values/types.js";

const resourceByteLength = 0x1_0000_0000;

// Validate the retained node rather than trusting its factory arguments.
// Analysis consumes `effects`, while realization consumes the operation's
// resource/configuration fields, so their agreement is an IR invariant.
export function validateResourceOperation(
  operation: ResourceOperation,
  path: string
): void {
  const label = `${path} ${operation.kind}`;

  assert(
    operation.width === 8 || operation.width === 16 || operation.width === 32,
    `${label} width must be 8, 16, or 32, got ${String(operation.width)}`
  );
  assert(
    Number.isInteger(operation.displacement) &&
      operation.displacement >= 0 &&
      operation.displacement <= 0xffff_ffff,
    `${label} address displacement must be an unsigned 32-bit integer, got ${operation.displacement}`
  );
  validateResourceEffect(operation.effect, label);

  if (operation.effect.range.slice !== undefined) {
    assert(
      operation.effect.range.slice.byteLength === operation.width / 8,
      `${label} exact range byte length ${operation.effect.range.slice.byteLength} must match ${operation.width}-bit transfer`
    );
  }

  assert(Array.isArray(operation.inputs), `${label} inputs must be an array`);
  assert(
    Array.isArray(operation.effects.reads) &&
      Array.isArray(operation.effects.writes),
    `${label} effects must contain read and write arrays`
  );

  switch (operation.kind) {
    case "resource.read":
      validateResourceRead(operation, label);
      return;
    case "resource.write":
      validateResourceWrite(operation, label);
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

function validateResourceRead(
  operation: Extract<ResourceOperation, { kind: "resource.read" }>,
  label: string
): void {
  const signed = (operation as { signed?: unknown }).signed;

  assert(
    signed === undefined || signed === true,
    `${label} signedness must be absent or true`
  );
  assert(
    signed !== true || operation.width !== 32,
    `${label} signedness is valid only for a narrow read`
  );
  assert(
    operation.inputs.length === 1 &&
      operation.inputs.every((input) => input.type === "i32"),
    `${label} must have exactly one i32 address input`
  );
  assert(
    operation.result !== undefined && operation.result.type === "i32",
    `${label} must have an i32 result`
  );
  assertReadBounds(
    operation.result.bounds,
    operation.width,
    signed === true,
    label
  );
  assert(
    operation.effects.reads.length === 1 &&
      operation.effects.reads[0] === operation.effect &&
      operation.effects.writes.length === 0,
    `${label} effects must read its exact resource effect and write nothing`
  );
}

function validateResourceWrite(
  operation: Extract<ResourceOperation, { kind: "resource.write" }>,
  label: string
): void {
  assert(
    operation.inputs.length === 2 &&
      operation.inputs.every((input) => input.type === "i32"),
    `${label} must have exactly one i32 address and one i32 value input`
  );
  assert(operation.result === undefined, `${label} must not have a result`);
  assert(
    operation.effects.reads.length === 0 &&
      operation.effects.writes.length === 1 &&
      operation.effects.writes[0] === operation.effect,
    `${label} effects must write its exact resource effect and read nothing`
  );
}

function assertReadBounds(
  actual: WidthBounds | undefined,
  width: 8 | 16 | 32,
  signed: boolean,
  label: string
): void {
  if (width === 32) {
    assert(actual === undefined, `${label} 32-bit result must be unbounded`);
    return;
  }

  const expected = signed ? signExtended(width) : fitsUnsigned(width);

  assert(
    actual !== undefined &&
      actual.unsignedBits === expected.unsignedBits &&
      actual.signedBits === expected.signedBits,
    `${label} result has bounds inconsistent with its transfer width and signedness`
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
