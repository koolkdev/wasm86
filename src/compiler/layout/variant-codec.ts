import { assert } from "#common/assert.js";
import type { LayoutWidth } from "./handles.js";
import type { VariantFieldRef, VariantLayout, VariantRef } from "./variant.js";

export type VariantPayload<TValue> = readonly Readonly<{
  field: VariantFieldRef;
  value: TValue;
}>[];

export type VariantValue<TValue> = Readonly<{
  variant: VariantRef;
  payload: VariantPayload<TValue>;
}>;

// One mechanical packing algorithm serves host encoding and symbolic
// construction. Targets supply only the scalar representation; tag/field
// placement and use order always come from the resolved VariantLayout.
export type VariantOps<TValue, TResult> = Readonly<{
  constant(value: bigint): TResult;
  unsigned(value: TValue, width: LayoutWidth): TResult;
  shiftLeft(value: TResult, bitCount: number): TResult;
  or(left: TResult, right: TResult): TResult;
}>;

export function packVariant<TValue, TResult>(
  layout: VariantLayout,
  value: VariantValue<TValue>,
  target: VariantOps<TValue, TResult>
): TResult {
  assertI64Layout(layout);
  const { variant, payload } = value;
  const placement = layout.variant(variant);
  const payloadByField = new Map<VariantFieldRef, TValue>();

  for (const entry of payload) {
    assert(
      variant.fields.includes(entry.field),
      `field ${entry.field.id} does not belong to variant ${variant.id}`
    );
    assert(
      !payloadByField.has(entry.field),
      `duplicate payload field for variant ${variant.id}: ${entry.field.id}`
    );
    payloadByField.set(entry.field, entry.value);
  }

  assert(
    payloadByField.size === variant.fields.length,
    `variant ${variant.id} payload has ${payloadByField.size} fields; expected ${variant.fields.length}`
  );

  let result = target.constant(BigInt(placement.tag) << BigInt(layout.tagOffset * 8));

  for (const field of variant.fields) {
    const value = payloadByField.get(field);

    assert(value !== undefined, `variant ${variant.id} is missing field ${field.id}`);
    const placement = layout.field(field);
    let packed = target.unsigned(value, field.width);

    if (placement.offset !== 0) {
      packed = target.shiftLeft(packed, placement.offset * 8);
    }
    result = target.or(result, packed);
  }

  return result;
}

export function encodeVariant(layout: VariantLayout, value: VariantValue<number>): bigint {
  const encoded = packVariant(layout, value, {
    constant: (value) => value,
    unsigned: (value, width) => {
      const maximum = widthMaximum(width);

      if (!Number.isInteger(value) || value < 0 || value > maximum) {
        throw new RangeError(`variant payload value does not fit ${width}: ${value}`);
      }
      return BigInt(value);
    },
    shiftLeft: (value, bitCount) => value << BigInt(bitCount),
    or: (left, right) => left | right
  });

  return BigInt.asIntN(64, encoded);
}

export type DecodedVariant = Readonly<{
  variant: VariantRef;
  value<TWidth extends LayoutWidth>(field: VariantFieldRef<TWidth>): number;
}>;

export function decodeVariant(layout: VariantLayout, encoded: bigint): DecodedVariant {
  assertI64Layout(layout);
  const value = BigInt.asUintN(64, encoded);
  const layoutMask = byteMask(layout.byteLength);

  if ((value & ~layoutMask) !== 0n) {
    throw new RangeError(`${layout.id} variant has bits outside its resolved layout`);
  }

  const tag = Number((value >> BigInt(layout.tagOffset * 8)) & 0xffn);
  const variant = layout.variantForTag(tag);
  let usedMask = 0xffn << BigInt(layout.tagOffset * 8);

  for (const field of variant.fields) {
    const placement = layout.field(field);

    usedMask |= byteMask(placement.byteLength) << BigInt(placement.offset * 8);
  }

  if ((value & ~usedMask) !== 0n) {
    throw new RangeError(`${layout.id} variant ${variant.id} has nonzero unused payload bits`);
  }

  return {
    variant,
    value<TWidth extends LayoutWidth>(field: VariantFieldRef<TWidth>): number {
      assert(
        variant.fields.includes(field),
        `field ${field.id} does not belong to decoded variant ${variant.id}`
      );
      const placement = layout.field(field);
      const fieldValue = (value >> BigInt(placement.offset * 8)) & byteMask(placement.byteLength);

      return Number(fieldValue);
    }
  };
}

function assertI64Layout(layout: VariantLayout): void {
  assert(
    layout.byteLength <= 8,
    `variant layout ${layout.id} does not fit an i64: ${layout.byteLength} bytes`
  );
}

function byteMask(byteLength: number): bigint {
  return (1n << BigInt(byteLength * 8)) - 1n;
}

function widthMaximum(width: LayoutWidth): number {
  switch (width) {
    case "u8":
      return 0xff;
    case "u16":
      return 0xffff;
    case "u32":
      return 0xffff_ffff;
  }
}
