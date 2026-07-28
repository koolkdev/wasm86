import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticsBuilder,
  SemanticOperandMemoryOptions,
  SemanticUpdate,
  SemanticTemplate
} from "#instructions/semantics/builder.js";
import type { Value, ValueInput } from "#instructions/semantics/refs.js";
import { widthMask, type OperandWidth } from "#core/types.js";
import { writeStatusFlagValues } from "./flag-writes.js";

export type BitTestOp = "bt" | "bts" | "btr" | "btc";
export type BitOffsetSource = "reg" | "imm8";
export type BitScanOp = "bsf" | "bsr";
export type BitFieldWidth = Extract<OperandWidth, 16 | 32>;

export function bitTestSemantic(
  op: BitTestOp,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource
): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const offset = readBitOffset(s, width, offsetSource);
    const bitIndex = v.binary("and", offset, v.const(width - 1));
    const memory = bitStringMemoryOptions(v, width, offsetSource, offset);

    if (op === "bt") {
      const value = v.truncate(
        width,
        s.read(dst, memory === undefined ? { width } : { width, memory })
      );

      writeBitTestFlag(s, v, value, bitIndex);
      return;
    }

    const target = s.update(dst, memory === undefined ? { width } : { width, memory });
    const value = v.truncate(width, target.read(s));

    writeBitTestResult(s, v, op, width, target, value, bitIndex);
  };
}

export function bitScanSemantic(op: BitScanOp, width: BitFieldWidth): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const source = v.truncate(width, s.read(src, { width }));
    const oldDestination = s.read(dst, { width });
    const sourceIsZero = v.compare(width, "eq", source, v.const(0));
    const scan = bitScanIndex(v, op, source);
    const scanOrZero = v.select(sourceIsZero, v.const(0), scan);
    const result = v.select(sourceIsZero, oldDestination, scan);

    writeBitScanFlags(s, v, sourceIsZero, scanOrZero);
    s.write(dst, result, { width });
  };
}

function readBitOffset(
  s: SemanticsBuilder,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource
): Value {
  return offsetSource === "reg"
    ? s.read(s.operand(1), { width, signed: true })
    : s.read(s.operand(1), { width: 8 });
}

function bitStringMemoryOptions(
  v: ValueBuilder,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource,
  offset: Value
): SemanticOperandMemoryOptions | undefined {
  if (offsetSource !== "reg") {
    return undefined;
  }

  return {
    addressOffset: () => {
      const element = v.binary("shr_s", offset, v.const(elementShift(width)));

      return v.binary("shl", element, v.const(byteShift(width)));
    }
  };
}

function writeBitTestResult(
  s: SemanticsBuilder,
  v: ValueBuilder,
  op: Exclude<BitTestOp, "bt">,
  width: BitFieldWidth,
  target: SemanticUpdate,
  value: Value,
  bitIndex: Value
): void {
  writeBitTestFlag(s, v, value, bitIndex);

  target.write(s, bitTestWriteResult(v, op, width, value, bitIndex));
}

function writeBitTestFlag(
  s: SemanticsBuilder,
  v: ValueBuilder,
  value: Value,
  bitIndex: Value
): void {
  const bit = lowBit(v, v.binary("shr_u", value, bitIndex));

  // BT/BTS/BTR/BTC define CF only. PF/AF/ZF/SF/OF are architecturally
  // undefined; the local hardware probe preserves them, so leave them
  // untouched by writing only CF.
  s.writeFlag("CF", bit);
}

function bitTestWriteResult(
  v: ValueBuilder,
  op: Exclude<BitTestOp, "bt">,
  width: BitFieldWidth,
  value: Value,
  bitIndex: Value
): Value {
  const mask = v.truncate(width, v.binary("shl", v.const(1), bitIndex));

  switch (op) {
    case "bts":
      return v.truncate(width, v.binary("or", value, mask));
    case "btr":
      return v.truncate(
        width,
        v.binary("and", value, v.binary("xor", mask, v.const(widthMask(width))))
      );
    case "btc":
      return v.truncate(width, v.binary("xor", value, mask));
  }
}

function bitScanIndex(v: ValueBuilder, op: BitScanOp, source: Value): Value {
  switch (op) {
    case "bsf":
      return v.unary("ctz", source);
    case "bsr":
      return v.binary("sub", v.const(31), v.unary("clz", source));
  }
}

function writeBitScanFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  sourceIsZero: Value,
  scanOrZero: Value
): void {
  const zero = v.const(0);
  const parity = parityFlag(v, scanOrZero);

  // BSF/BSR define ZF only. CF/PF/AF/SF/OF are architecturally undefined;
  // these writes mirror the local hardware probe: CF/AF/SF/OF clear, and PF
  // is parity of the produced scan index, using index 0 for a zero source.
  writeStatusFlagValues(s, {
    CF: zero,
    PF: parity,
    AF: zero,
    ZF: sourceIsZero,
    SF: zero,
    OF: zero
  });
}

function parityFlag(v: ValueBuilder, value: ValueInput): Value {
  const lowByte = v.binary("and", value, v.const(0xff));
  const odd = lowBit(v, v.unary("popcnt", lowByte));

  return v.compare(32, "eq", odd, v.const(0));
}

function lowBit(v: ValueBuilder, value: ValueInput): Value {
  return v.binary("and", value, v.const(1));
}

function elementShift(width: BitFieldWidth): 4 | 5 {
  switch (width) {
    case 16:
      return 4;
    case 32:
      return 5;
  }
}

function byteShift(width: BitFieldWidth): 1 | 2 {
  switch (width) {
    case 16:
      return 1;
    case 32:
      return 2;
  }
}
