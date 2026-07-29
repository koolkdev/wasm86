import type { ValueType } from "#compiler/value.js";

export type I32Width = 8 | 16 | 32;
export type IntegerWidth = I32Width | 64;

const integerTypeByWidth = {
  8: "i32",
  16: "i32",
  32: "i32",
  64: "i64"
} as const satisfies Readonly<Record<IntegerWidth, ValueType>>;

export type IntegerTypeForWidth<Width extends IntegerWidth> = (typeof integerTypeByWidth)[Width];

export function integerTypeForWidth<Width extends IntegerWidth>(
  width: Width
): IntegerTypeForWidth<Width> {
  return integerTypeByWidth[width];
}

export function effectiveShiftAmount(width: IntegerWidth, value: bigint): number {
  return Number(value & (width === 64 ? 63n : 31n));
}
