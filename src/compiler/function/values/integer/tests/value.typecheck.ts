import type { BitValue, I32Value, I64Value, Integer, ValueRef } from "#compiler/function/values.js";
import type { IntegerWidth } from "../width.js";
import type { ExtensionTargets, SignedView, TruncationTargets, UnsignedView } from "../types.js";

export function integerValueContract(
  value32: I32Value,
  wide: I64Value,
  predicate: BitValue,
  byte: Integer<8>,
  word: Integer<16>
): void {
  const sum: Integer<8> = byte.add(1);
  const carried: Integer<8> = byte.addWithCarry(1, predicate);
  const shifted: Integer<8> = byte.shl(word);
  const quotient: Integer<8> = byte.signed.div(1);
  const compared: BitValue = byte.unsigned.lt(0);
  const zero: BitValue = value32.eqz();
  const bitCount: Integer<8> = byte.popcnt();
  const signed: SignedView<8> = byte.signed;
  const widened: I32Value = byte.unsigned.extend(32);
  const narrowed: Integer<8> = value32.truncate(8);
  const valueRef: ValueRef = byte;

  // @ts-expect-error arithmetic requires matching widths.
  byte.add(word);
  // @ts-expect-error i32 values use number literals.
  value32.add(1n);
  // @ts-expect-error i64 values use bigint literals.
  wide.add(1);
  // @ts-expect-error one-bit operands must be zero or one.
  predicate.add(2);
  // @ts-expect-error carry inputs must be one-bit values.
  byte.addWithCarry(1, byte);
  // @ts-expect-error shift counts must be at most 32 bits wide.
  byte.shl(wide);
  // @ts-expect-error division must choose signed or unsigned semantics.
  byte.div(1);
  // @ts-expect-error extension cannot narrow.
  word.signed.extend(8);
  // @ts-expect-error truncation cannot widen.
  byte.truncate(16);
  // @ts-expect-error signed views are operation namespaces, not semantic values.
  const viewAsValue: ValueRef = signed;
  // @ts-expect-error semantic values cannot be forged from their public fields.
  const forgedValue: ValueRef = { kind: "integer", width: 32 };
  // @ts-expect-error signed and unsigned views are distinct operation namespaces.
  const relabeled: UnsignedView<8> = signed;
  const add = byte.add;
  // @ts-expect-error fluent methods require their originating receiver.
  add(1);

  void [
    sum,
    carried,
    shifted,
    quotient,
    compared,
    zero,
    bitCount,
    signed,
    widened,
    narrowed,
    valueRef,
    viewAsValue,
    forgedValue,
    relabeled
  ];
}

export function genericConversionContract<
  Width extends IntegerWidth,
  ExtendedWidth extends ExtensionTargets<Width>,
  TruncatedWidth extends TruncationTargets<Width>
>(
  value: Integer<Width>,
  extendedWidth: ExtendedWidth,
  truncatedWidth: TruncatedWidth
): readonly [Integer<ExtendedWidth>, Integer<TruncatedWidth>] {
  return [value.unsigned.extend(extendedWidth), value.truncate(truncatedWidth)];
}

export function unionConversionContract(value: Integer<8 | 64>): void {
  // @ts-expect-error the source may be wider than the extension target.
  value.unsigned.extend(32);
  // @ts-expect-error the source may be narrower than the truncation target.
  value.truncate(32);
}
