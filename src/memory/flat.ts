import { assert } from "#common/assert.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import {
  DynamicByteOriginRef,
  type ByteRange,
  type ResourceByteOperand,
  resourceRef,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { guestMemoryMinimumByteLength } from "./constants.js";

export const guestMemoryResource = resourceRef("memory.guest");

export type FlatMemoryFault<TIntent extends string> = Readonly<{
  address: ValueId;
  intent: TIntent;
}>;

export type FlatMemoryAccess<TIntent extends string> = Readonly<{
  resource: ResourceRef;
  origin: DynamicByteOriginRef;
  start: ValueId;
  byteLength: ValueId;
  invalid: ValueId;
  fault: FlatMemoryFault<TIntent>;
  intent: TIntent;
}>;

type FlatMemoryValues = Pick<ValueBuilder, "const" | "binary" | "compare"> & ConstantValues;

type ConstantValues = Readonly<{
  constValue(value: ValueId): number | undefined;
}>;

const addressSpaceByteLength = 0x1_0000_0000;

export function flatMemoryAccess<TIntent extends string>(
  values: FlatMemoryValues,
  start: ValueId,
  byteLength: ValueId,
  intent: TIntent
): FlatMemoryAccess<TIntent> {
  const staticByteLength = values.constValue(byteLength);

  if (staticByteLength !== undefined) {
    assert(
      Number.isInteger(staticByteLength) &&
        staticByteLength > 0 &&
        staticByteLength <= guestMemoryMinimumByteLength,
      `flat access byte length must be an integer between 1 and ${guestMemoryMinimumByteLength}, got ${staticByteLength}`
    );

    return createFlatMemoryAccess(
      start,
      byteLength,
      values.compare(
        32,
        "gt_u",
        start,
        values.const(guestMemoryMinimumByteLength - staticByteLength)
      ),
      intent
    );
  }

  const zero = values.const(0);
  const one = values.const(1);
  const last = values.const(guestMemoryMinimumByteLength - 1);
  const lengthMinusOne = values.binary("sub", byteLength, one);
  const invalidNonzeroRange = values.binary(
    "or",
    values.compare(32, "gt_u", start, last),
    values.compare(
      32,
      "gt_u",
      lengthMinusOne,
      values.binary("sub", last, start)
    )
  );
  const invalid = values.binary(
    "and",
    values.compare(32, "ne", byteLength, zero),
    invalidNonzeroRange
  );
  return createFlatMemoryAccess(start, byteLength, invalid, intent);
}

function createFlatMemoryAccess<TIntent extends string>(
  start: ValueId,
  byteLength: ValueId,
  invalid: ValueId,
  intent: TIntent
): FlatMemoryAccess<TIntent> {
  return {
    resource: guestMemoryResource,
    origin: new DynamicByteOriginRef(),
    start,
    byteLength,
    invalid,
    fault: { address: start, intent },
    intent
  };
}

// Classify only from facts issued by this access. Value identities are never
// reverse-engineered: a dynamic offset therefore widens to the whole origin.
export function flatMemoryOperand(
  values: FlatMemoryValues,
  access: Pick<
    FlatMemoryAccess<string>,
    "resource" | "origin" | "start" | "byteLength"
  >,
  byteOffset: ValueId,
  width: IntegerWidth
): ResourceByteOperand {
  assert(
    width === 8 || width === 16 || width === 32,
    `flat operation width must be 8, 16, or 32, got ${String(width)}`
  );
  const byteLength = width / 8;
  const staticAccessByteLength = values.constValue(access.byteLength);
  const staticByteOffset = values.constValue(byteOffset);

  assert(
    staticByteOffset === undefined || staticByteOffset >= 0,
    `memory byte offset must be non-negative, got ${String(staticByteOffset)}`
  );
  assert(
    staticByteOffset === undefined ||
      staticAccessByteLength === undefined ||
      staticByteOffset + byteLength <= staticAccessByteLength,
    `${width}-bit memory access at byte offset ${String(staticByteOffset)} exceeds ${String(staticAccessByteLength)}-byte resolution`
  );
  const range = flatMemoryRange(values, access, staticByteOffset, byteLength);
  const base = staticByteOffset === undefined
    ? values.binary("add", access.start, byteOffset)
    : access.start;

  return {
    effect: { space: "resource", resource: access.resource, range },
    address: {
      base,
      displacement: staticByteOffset ?? 0
    },
    width
  };
}

function flatMemoryRange(
  values: ConstantValues,
  access: Pick<FlatMemoryAccess<string>, "origin" | "start">,
  staticByteOffset: number | undefined,
  byteLength: number
): ByteRange {
  if (staticByteOffset === undefined) {
    return { basis: { kind: "dynamic", origin: access.origin } };
  }
  const staticStart = values.constValue(access.start);

  if (staticStart !== undefined) {
    const absoluteStart = (staticStart >>> 0) + staticByteOffset;

    if (absoluteStart + byteLength <= addressSpaceByteLength) {
      return {
        basis: { kind: "resource" },
        slice: { byteOffset: absoluteStart, byteLength }
      };
    }
  }

  return {
    basis: { kind: "dynamic", origin: access.origin },
    slice: { byteOffset: staticByteOffset, byteLength }
  };
}
