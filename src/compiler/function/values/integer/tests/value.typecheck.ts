import {
  integer,
  i32,
  i64,
  nonzero,
  select,
  u8,
  u16,
  type AnyInteger,
  type AnyNarrowInteger,
  type BitValue,
  type Integer,
  type ExtensionTargets,
  type I32Value,
  type I64Value,
  type SignedView,
  type TruncationTargets,
  type UnsignedView
} from "#compiler/function/values.js";
import type { StorageWidth } from "#compiler/function/resource.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { IntegerRef, ValueRef } from "#compiler/function/values/reference.js";

export function valueTypeContract(
  value32: I32Value,
  wide: I64Value,
  predicate: BitValue,
  byte: Integer<8>,
  word: Integer<16>,
  dynamic: AnyNarrowInteger,
  either: ValueRef
): void {
  const sum32: I32Value = value32.add(1);
  const sum64: I64Value = wide.add(1n);
  const unsignedByteLiteral: Integer<8> = u8(0xff);
  const unsignedWordLiteral: Integer<16> = u16(0xffff);
  const predicate32: BitValue = byte.unsigned.lt(0xff);
  const predicate64: BitValue = wide.signed.ge(0n);
  const zeroPredicate: BitValue = value32.eqz();
  const selectedLiteral: I32Value = select(predicate, i32(1), sum32);
  const selectedWideLiteral: I64Value = select(predicate, i64(1n), sum64);
  const selectedByte: Integer<8> = select(predicate, byte, u8(1));
  const selectedTypedByte: Integer<8> = select(predicate, u8(1), u8(0));
  const selectedPredicate: BitValue = select(predicate, predicate32, predicate64);
  const shiftedByWord: Integer<8> = byte.shl(word);
  const shiftedByPredicate: Integer<8> = byte.shl(predicate);
  const bitLiteral: BitValue = integer(1, 1);
  const selectedBit: BitValue = byte.bit(3);
  const selectedMsb: BitValue = byte.msb();
  const byteNonzero: BitValue = nonzero(byte);
  const wideNonzero: BitValue = nonzero(wide);
  const truncatedBit: BitValue = wide.truncate(1);
  const widenedPredicate: I32Value = predicate.unsigned.extend(32);
  const signedWide: I64Value = byte.signed.extend(64);
  const unsignedWide: I64Value = byte.unsigned.extend(64);
  const wrapped: Integer<32> = wide.truncate(32);
  const byteRef: IntegerRef<8> = byte;
  const bitRef: IntegerRef<1> = predicate;
  const wideRef: IntegerRef<64> = wide;
  const byteSum: Integer<8> = byte.add(1);
  const predicateSum: BitValue = predicate.add(1);
  const neutralWord: Integer<16> = byte.unsigned.extend(16);
  const anyInteger: AnyInteger = wide;
  const narrowed = value32.truncate(8);

  switch (dynamic.width) {
    case 1:
      dynamic.add(1);
      break;
    case 8:
      dynamic.add(u8(1));
      break;
    case 16:
      dynamic.add(u16(1));
      break;
    case 32:
      dynamic.add(i32(1));
      break;
  }

  const dynamicWidth: IntegerWidth = either.width;

  // @ts-expect-error arithmetic requires matching widths.
  byte.add(word);
  // @ts-expect-error arithmetic does not implicitly truncate a full i32.
  byte.add(value32);
  // @ts-expect-error neutral values do not choose signed division.
  byte.div(2);
  // @ts-expect-error signed views are operation namespaces, not values.
  const viewAsRef: IntegerRef<8> = byte.signed;
  // @ts-expect-error value references can only come from the expression system.
  const forgedRef: IntegerRef<32> = { width: 32 };
  // @ts-expect-error neutral widening must choose signed or unsigned extension.
  byte.extend(16);
  // @ts-expect-error truncation cannot widen.
  byte.truncate(16);
  // @ts-expect-error extension cannot value32.
  word.signed.extend(8);
  // @ts-expect-error arithmetic returns neutral bits.
  const sumAsView: typeof byte.signed = byteSum;
  // @ts-expect-error i32 and i64 values cannot be mixed.
  value32.xor(wide);
  // @ts-expect-error shift counts must be at most 32 bits wide.
  byte.shl(wide);
  // @ts-expect-error one-bit operands must be zero or one.
  predicate.add(2);
  // @ts-expect-error comparisons require matching widths.
  byte.unsigned.lt(word);
  // @ts-expect-error i32 values use number literals.
  value32.add(1n);
  // @ts-expect-error i64 values use bigint literals.
  wide.add(1);
  // @ts-expect-error i32 comparisons use number literals.
  byte.eq(0n);
  // @ts-expect-error i64 comparisons use bigint literals.
  wide.eq(0);
  // @ts-expect-error conditions must be one-bit values.
  select(value32, i32(1), sum32);
  // @ts-expect-error narrow integers are not conditions without an explicit zero test.
  select(byte, byte, u8(0));
  // @ts-expect-error select alternatives must have one width.
  select(predicate, byte, word);
  // @ts-expect-error i32 and i64 select alternatives cannot mix.
  select(predicate, value32, wide);
  // @ts-expect-error select alternatives must be explicitly typed values.
  select(predicate, value32, 0);
  // @ts-expect-error an unnarrowed dynamic union has no safe peer width.
  dynamic.add(byte);
  const add = byte.add;
  // @ts-expect-error fluent methods require their originating receiver.
  add(1);
  const divide = byte.signed.div;
  // @ts-expect-error signed operations require their originating view.
  divide(1);
  // @ts-expect-error i32 constants use JavaScript numbers.
  i32(1n);
  // @ts-expect-error i64 constants use JavaScript bigints.
  i64(1);
  // @ts-expect-error one-bit literals must be zero or one.
  integer(1, 2);

  void [
    predicate32,
    predicate64,
    zeroPredicate,
    unsignedByteLiteral,
    unsignedWordLiteral,
    selectedLiteral,
    selectedWideLiteral,
    selectedByte,
    selectedTypedByte,
    selectedPredicate,
    shiftedByWord,
    shiftedByPredicate,
    bitLiteral,
    selectedBit,
    selectedMsb,
    byteNonzero,
    wideNonzero,
    truncatedBit,
    widenedPredicate,
    signedWide,
    unsignedWide,
    wrapped,
    byteRef,
    bitRef,
    wideRef,
    byteSum,
    predicateSum,
    neutralWord,
    anyInteger,
    narrowed,
    dynamicWidth,
    viewAsRef,
    forgedRef,
    sumAsView
  ];
}

export function dynamicLiteralContract<Width extends Exclude<IntegerWidth, 64>>(
  width: Width
): Integer<Width> {
  return integer(width, 1);
}

export function genericExtensionContract<Width extends Exclude<IntegerWidth, 64>>(
  value: Integer<Width>
): Integer<32> {
  return value.unsigned.extend(32);
}

export function genericTruncationContract<Width extends StorageWidth | 64>(
  value: Integer<Width>
): Integer<8> {
  return value.truncate(8);
}

export function unsafeGenericExtension<Width extends StorageWidth | 64>(
  value: Integer<Width>
): void {
  // @ts-expect-error 64-bit values cannot extend to 32 bits.
  value.unsigned.extend(32);
}

export function genericExtensionTarget<
  Width extends StorageWidth | 64,
  TargetWidth extends ExtensionTargets<Width>
>(value: Integer<Width>, width: TargetWidth): Integer<TargetWidth> {
  return value.unsigned.extend(width);
}

export function genericTruncationTarget<
  Width extends StorageWidth | 64,
  TargetWidth extends TruncationTargets<Width>
>(value: Integer<Width>, width: TargetWidth): Integer<TargetWidth> {
  return value.truncate(width);
}

export function unionWidthContract(
  value32: I32Value,
  wide: I64Value,
  extensionWidth: 32 | 64,
  truncationWidth: 8 | 16
): void {
  value32.unsigned.extend(extensionWidth);
  value32.truncate(truncationWidth);

  // @ts-expect-error the target may be narrower than the source.
  wide.unsigned.extend(extensionWidth);
  // @ts-expect-error the target may be wider than the source.
  u8(0).truncate(truncationWidth);
}

export function unionSourceContract(value: Integer<8 | 64>): void {
  // @ts-expect-error the source may be wider than the extension target.
  value.unsigned.extend(32);
  // @ts-expect-error the source may be narrower than the truncation target.
  value.truncate(32);
}

export function signednessContract(byte: Integer<8>): void {
  const signed: SignedView<8> = byte.signed;
  const unsigned: UnsignedView<8> = byte.unsigned;
  const signedKind: "signed" = signed.signedness;
  const unsignedKind: "unsigned" = unsigned.signedness;

  // @ts-expect-error a signed view cannot become unsigned.
  const relabeledUnsigned: UnsignedView<8> = signed;
  // @ts-expect-error an unsigned view cannot become signed.
  const relabeledSigned: SignedView<8> = unsigned;

  void [signedKind, unsignedKind, relabeledUnsigned, relabeledSigned];
}
