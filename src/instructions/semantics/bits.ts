import {
  integer,
  select,
  type Integer,
  type BitValue,
  type I32Value
} from "#compiler/function/values.js";
import type {
  SemanticsBuilder,
  SemanticReadOptions,
  InstructionSemantics
} from "#instructions/semantics/builder.js";
import { widthMask, type OperandWidth } from "#core/types.js";
import { writeStatusFlagValues } from "./flag-writes.js";

export type BitTestOp = "bt" | "bts" | "btr" | "btc";
export type BitOffsetSource = "reg" | "imm8";
export type BitScanOp = "bsf" | "bsr";
export type BitFieldWidth = Extract<OperandWidth, 16 | 32>;

export function bitTestSemantic<Width extends BitFieldWidth>(
  op: BitTestOp,
  width: Width,
  offsetSource: BitOffsetSource
): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const offset = readBitOffset(s, width, offsetSource);
    const bitIndex = offset.and(width - 1);
    const options = bitStringReadOptions(width, offsetSource, offset);

    if (op === "bt") {
      const value = s.read(dst, width, options);

      writeBitTestFlag(s, value, bitIndex);
      return;
    }

    const target = s.update(dst, width, options);
    const value = s.read(target);

    writeBitTestFlag(s, value, bitIndex);
    s.write(target, bitTestWriteResult(op, value, bitIndex));
  };
}

export function bitScanSemantic<Width extends BitFieldWidth>(
  op: BitScanOp,
  width: Width
): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const source = s.read(src, width);
    const oldDestination = s.read(dst, width);
    const sourceIsZero = source.eq(0);
    const scan = bitScanIndex(op, source);
    const scanOrZero = select(sourceIsZero, integer(source.width, 0), scan);
    const result = select(sourceIsZero, oldDestination, scan);

    writeBitScanFlags(s, sourceIsZero, scanOrZero);
    s.write(dst, result);
  };
}

function readBitOffset<Width extends BitFieldWidth>(
  s: SemanticsBuilder,
  width: Width,
  offsetSource: BitOffsetSource
): I32Value {
  return offsetSource === "reg"
    ? s.read(s.operand(1), width).signed.extend(32)
    : s.read(s.operand(1), 8).unsigned.extend(32);
}

function bitStringReadOptions(
  width: BitFieldWidth,
  offsetSource: BitOffsetSource,
  offset: I32Value
): SemanticReadOptions | undefined {
  if (offsetSource !== "reg") {
    return undefined;
  }

  const indexShift = Math.log2(width);
  const byteShift = Math.log2(width / 8);

  return {
    addressOffset: offset.signed.shr(indexShift).shl(byteShift)
  };
}

function writeBitTestFlag<Width extends BitFieldWidth>(
  s: SemanticsBuilder,
  value: Integer<Width>,
  bitIndex: I32Value
): void {
  const bit = value.bit(bitIndex);

  // BT/BTS/BTR/BTC define CF only. PF/AF/ZF/SF/OF are architecturally
  // undefined; the local hardware probe preserves them, so leave them
  // untouched by writing only CF.
  s.writeFlag("CF", bit);
}

function bitTestWriteResult<Width extends BitFieldWidth>(
  op: Exclude<BitTestOp, "bt">,
  value: Integer<Width>,
  bitIndex: I32Value
): Integer<Width> {
  const mask = integer(value.width, 1).shl(bitIndex);

  switch (op) {
    case "bts":
      return value.or(mask);
    case "btr":
      return value.and(mask.xor(widthMask(value.width)));
    case "btc":
      return value.xor(mask);
  }
}

function bitScanIndex<Width extends BitFieldWidth>(
  op: BitScanOp,
  source: Integer<Width>
): Integer<Width> {
  switch (op) {
    case "bsf":
      return source.ctz();
    case "bsr":
      return integer(source.width, source.width - 1).sub(source.clz());
  }
}

function writeBitScanFlags<Width extends BitFieldWidth>(
  s: SemanticsBuilder,
  sourceIsZero: BitValue,
  scanOrZero: Integer<Width>
): void {
  const parity = parityFlag(scanOrZero);

  // BSF/BSR define ZF only. CF/PF/AF/SF/OF are architecturally undefined;
  // these writes mirror the local hardware probe: CF/AF/SF/OF clear, and PF
  // is parity of the produced scan index, using index 0 for a zero source.
  writeStatusFlagValues(s, {
    CF: integer(1, 0),
    PF: parity,
    AF: integer(1, 0),
    ZF: sourceIsZero,
    SF: integer(1, 0),
    OF: integer(1, 0)
  });
}

function parityFlag<Width extends BitFieldWidth>(value: Integer<Width>): BitValue {
  const lowByte = value.and(0xff);
  const odd = lowByte.popcnt().bit(0);

  return odd.eqz();
}
