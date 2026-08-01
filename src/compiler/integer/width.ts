import type { ValueType } from "#compiler/ir/values/types.js";

export type AccessWidth = 8 | 16 | 32 | 64;
export type IntegerWidth = 1 | AccessWidth;

export type WidthsAtLeast<Width extends IntegerWidth> = [Width] extends [1]
  ? IntegerWidth
  : [Width] extends [1 | 8]
    ? AccessWidth
    : [Width] extends [1 | 8 | 16]
      ? 16 | 32 | 64
      : [Width] extends [1 | 8 | 16 | 32]
        ? 32 | 64
        : 64;

export type WidthsAtMost<Width extends IntegerWidth> = [Width] extends [64]
  ? IntegerWidth
  : [Width] extends [32 | 64]
    ? 1 | 8 | 16 | 32
    : [Width] extends [16 | 32 | 64]
      ? 1 | 8 | 16
      : [Width] extends [AccessWidth]
        ? 1 | 8
        : 1;

const carrierTypeByWidth = {
  1: "i32",
  8: "i32",
  16: "i32",
  32: "i32",
  64: "i64"
} as const satisfies Readonly<Record<IntegerWidth, ValueType>>;

export type CarrierTypeForWidth<Width extends IntegerWidth> = (typeof carrierTypeByWidth)[Width];

export function carrierTypeForWidth<Width extends IntegerWidth>(
  width: Width
): CarrierTypeForWidth<Width> {
  return carrierTypeByWidth[width];
}

export function effectiveShiftAmount(width: IntegerWidth, value: bigint): number {
  return Number(value & (width === 64 ? 63n : 31n));
}
