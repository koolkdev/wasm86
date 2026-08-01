export type IntegerWidth = 1 | 8 | 16 | 32 | 64;
export type StorageWidth = Exclude<IntegerWidth, 1>;

type WidthsAtMost1 = 1;
type WidthsAtMost8 = WidthsAtMost1 | 8;
type WidthsAtMost16 = WidthsAtMost8 | 16;
type WidthsAtMost32 = WidthsAtMost16 | 32;
type WidthsAtMost64 = WidthsAtMost32 | 64;

type WidthsAtLeast64 = 64;
type WidthsAtLeast32 = 32 | WidthsAtLeast64;
type WidthsAtLeast16 = 16 | WidthsAtLeast32;
type WidthsAtLeast8 = 8 | WidthsAtLeast16;
type WidthsAtLeast1 = 1 | WidthsAtLeast8;

// Union inputs retain only targets that are valid for every possible width.
export type WidthsAtMost<Widths extends IntegerWidth> = 1 extends Widths
  ? WidthsAtMost1
  : 8 extends Widths
    ? WidthsAtMost8
    : 16 extends Widths
      ? WidthsAtMost16
      : 32 extends Widths
        ? WidthsAtMost32
        : WidthsAtMost64;

export type WidthsAtLeast<Widths extends IntegerWidth> = 64 extends Widths
  ? WidthsAtLeast64
  : 32 extends Widths
    ? WidthsAtLeast32
    : 16 extends Widths
      ? WidthsAtLeast16
      : 8 extends Widths
        ? WidthsAtLeast8
        : WidthsAtLeast1;

export type StorageValueWidth<Width extends StorageWidth> = WidthsAtMost<Width>;

export function effectiveShiftAmount(width: IntegerWidth, value: bigint): number {
  return Number(value & (width === 64 ? 63n : 31n));
}
