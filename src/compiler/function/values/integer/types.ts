import type {
  IntegerWidth,
  WidthsAtLeast,
  WidthsAtMost
} from "#compiler/function/values/integer/width.js";
import type { IntegerRef } from "../reference.js";

export type { WidthsAtLeast, WidthsAtMost } from "#compiler/function/values/integer/width.js";

type IntegerLiteralByWidth = Readonly<{
  1: 0 | 1;
  8: number;
  16: number;
  32: number;
  64: bigint;
}>;

export type IntegerLiteral<Width extends IntegerWidth> = IntegerLiteralByWidth[Width];

export type IntegerOperand<Width extends IntegerWidth> =
  Integer<NoInfer<Width>> | IntegerLiteral<Width>;

export type ShiftCount = AnyNarrowInteger | number;

export type ExtensionTargets<Source extends IntegerWidth> = WidthsAtLeast<Source>;

export type TruncationTargets<Source extends IntegerWidth> = WidthsAtMost<Source>;

interface TruncateOperation<Width extends IntegerWidth> {
  <TargetWidth extends TruncationTargets<Width>>(
    this: Integer<Width>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  <TargetWidth extends IntegerWidth>(
    this: Integer<Width> &
      Readonly<{
        width: WidthsAtLeast<TargetWidth>;
      }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
}

export type Signedness = "signed" | "unsigned";

interface ExtendOperation<Width extends IntegerWidth, Mode extends Signedness> {
  <TargetWidth extends ExtensionTargets<Width>>(
    this: SignednessView<Width, Mode>,
    width: TargetWidth
  ): Integer<TargetWidth>;
  <TargetWidth extends IntegerWidth>(
    this: SignednessView<Width, Mode> &
      Readonly<{
        width: WidthsAtMost<TargetWidth>;
      }>,
    width: TargetWidth
  ): Integer<TargetWidth>;
}

export interface Integer<Width extends IntegerWidth> extends IntegerRef<Width> {
  readonly kind: "integer";
  readonly width: Width;

  readonly add: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly addWithCarry: (
    this: Integer<Width>,
    other: IntegerOperand<Width>,
    carry: BitValue
  ) => Integer<Width>;
  readonly sub: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly subWithBorrow: (
    this: Integer<Width>,
    other: IntegerOperand<Width>,
    borrow: BitValue
  ) => Integer<Width>;
  readonly mul: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly and: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly or: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly xor: (this: Integer<Width>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly shl: (this: Integer<Width>, count: ShiftCount) => Integer<Width>;
  readonly rotl: (this: Integer<Width>, count: ShiftCount) => Integer<Width>;
  readonly rotr: (this: Integer<Width>, count: ShiftCount) => Integer<Width>;

  readonly eq: (this: Integer<Width>, other: IntegerOperand<Width>) => BitValue;
  readonly ne: (this: Integer<Width>, other: IntegerOperand<Width>) => BitValue;

  readonly eqz: (this: Integer<Width>) => BitValue;
  readonly bit: (this: Integer<Width>, index: ShiftCount) => BitValue;
  readonly msb: (this: Integer<Width>) => BitValue;
  readonly popcnt: (this: Integer<Width>) => Integer<Width>;
  readonly ctz: (this: Integer<Width>) => Integer<Width>;
  readonly clz: (this: Integer<Width>) => Integer<Width>;

  readonly truncate: TruncateOperation<Width>;

  readonly signed: SignedView<Width>;
  readonly unsigned: UnsignedView<Width>;
}

export interface SignednessView<Width extends IntegerWidth, Mode extends Signedness> {
  readonly width: Width;
  readonly signedness: Mode;

  readonly div: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly rem: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => Integer<Width>;
  readonly shr: (this: SignednessView<Width, Mode>, count: ShiftCount) => Integer<Width>;
  readonly lt: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => BitValue;
  readonly le: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => BitValue;
  readonly gt: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => BitValue;
  readonly ge: (this: SignednessView<Width, Mode>, other: IntegerOperand<Width>) => BitValue;
  readonly extend: ExtendOperation<Width, Mode>;
}

export type SignedView<Width extends IntegerWidth> = SignednessView<Width, "signed">;

export type UnsignedView<Width extends IntegerWidth> = SignednessView<Width, "unsigned">;

export type BitValue = Integer<1>;
export type I32Value = Integer<32>;
export type I64Value = Integer<64>;

export type AnyNarrowInteger = BitValue | Integer<8> | Integer<16> | I32Value;

export type AnyInteger = AnyNarrowInteger | Integer<64>;
