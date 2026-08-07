import { assert } from "#common/assert.js";
import type { IntegerWidth } from "./width.js";
import type { IntegerRef, ValueRef } from "../reference.js";
import { integerExtend, integerTruncate } from "./value.js";
import type { Integer, ExtensionTargets, Signedness, TruncationTargets } from "./types.js";

export function extendInteger<
  Width extends IntegerWidth,
  TargetWidth extends ExtensionTargets<Width>
>(value: Integer<Width>, signedness: Signedness, width: TargetWidth): Integer<TargetWidth>;
export function extendInteger(
  value: IntegerRef,
  signedness: Signedness,
  width: IntegerWidth
): ValueRef;
export function extendInteger(
  value: IntegerRef,
  signedness: Signedness,
  width: IntegerWidth
): ValueRef {
  assert(width >= value.width, `cannot extend ${value.width} bits to ${width} bits`);

  if (width === value.width) {
    return value;
  }
  assert(width !== 1, "1-bit extension must preserve width");
  return integerExtend(width, value, signedness === "signed");
}

export function truncateInteger<
  Width extends IntegerWidth,
  TargetWidth extends TruncationTargets<Width>
>(value: Integer<Width>, width: TargetWidth): Integer<TargetWidth>;
export function truncateInteger(value: IntegerRef, width: IntegerWidth): ValueRef;
export function truncateInteger(value: IntegerRef, width: IntegerWidth): ValueRef {
  assert(width <= value.width, `cannot truncate ${value.width} bits to ${width} bits`);

  if (width === value.width) {
    return value;
  }
  assert(width !== 64, "64-bit truncation must preserve width");
  return integerTruncate(width, value);
}
