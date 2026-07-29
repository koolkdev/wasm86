import type { ValueType } from "#compiler/value.js";

export type I32Width = 8 | 16 | 32;
export type IntegerWidth = I32Width | 64;
export type ValueWidth = 1 | IntegerWidth;

const carrierTypeByWidth = {
  1: "i32",
  8: "i32",
  16: "i32",
  32: "i32",
  64: "i64"
} as const satisfies Readonly<Record<ValueWidth, ValueType>>;

export type CarrierTypeForWidth<Width extends ValueWidth> = (typeof carrierTypeByWidth)[Width];

export function carrierTypeForWidth<Width extends ValueWidth>(
  width: Width
): CarrierTypeForWidth<Width> {
  return carrierTypeByWidth[width];
}

export function effectiveShiftAmount(width: ValueWidth, value: bigint): number {
  return Number(value & (width === 64 ? 63n : 31n));
}
