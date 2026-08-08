export type IntegerWidth = 1 | 8 | 16 | 32 | 64;

export type WidthsAtLeast<Width extends IntegerWidth> = 64 extends Width
  ? 64
  : 32 extends Width
    ? 32 | 64
    : 16 extends Width
      ? 16 | 32 | 64
      : 8 extends Width
        ? 8 | 16 | 32 | 64
        : IntegerWidth;

export type WidthsAtMost<Width extends IntegerWidth> = 1 extends Width
  ? 1
  : 8 extends Width
    ? 1 | 8
    : 16 extends Width
      ? 1 | 8 | 16
      : 32 extends Width
        ? 1 | 8 | 16 | 32
        : IntegerWidth;

export function normalizeInteger(width: IntegerWidth, value: number | bigint): bigint {
  return BigInt.asUintN(width, BigInt(value));
}
