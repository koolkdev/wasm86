import type { Values } from "#ir/values.js";
import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#core/semantics/builder.js";
import type { OperandRef, Value, ValueInput } from "#core/semantics/refs.js";
import { widthMask, type OperandWidth } from "#core/types.js";
import { writeStatusFlagValues } from "./flag-writes.js";
import {
  readStorage,
  resolveMemoryAccess,
  resolveStorageRead,
  resolveStorageReadWrite,
  resolvedOperandStorage,
  writeStorage,
  type ResolvedStorageAccess
} from "./memory.js";

export type BitTestOp = "bt" | "bts" | "btr" | "btc";
export type BitOffsetSource = "reg" | "imm8";
export type BitScanOp = "bsf" | "bsr";
export type BitFieldWidth = Extract<OperandWidth, 16 | 32>;

export function bitTestSemantic(
  op: BitTestOp,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource
): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const dstStorage = resolvedOperandStorage(context, dst);

    if (dstStorage === "mem" && offsetSource === "reg") {
      bitStringMemorySemantic(s, v, op, width, dst);
      return;
    }

    const bitIndex = simpleBitIndex(s, v, width, offsetSource);

    if (op === "bt") {
      const target = resolveStorageRead(s, v, context, dst, width);
      const value = v.truncate(width, readStorage(s, v, target, width));

      writeBitTestFlag(s, v, value, bitIndex);
      return;
    }

    const target = resolveStorageReadWrite(s, v, context, dst, width);
    const value = v.truncate(width, readStorage(s, v, target, width));

    writeBitTestResult(s, v, op, width, target, value, bitIndex);
  };
}

export function bitScanSemantic(op: BitScanOp, width: BitFieldWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const sourceAccess = resolveStorageRead(s, v, context, src, width);

    const source = v.truncate(width, readStorage(s, v, sourceAccess, width));
    const oldDestination = s.get(dst, width);
    const sourceIsZero = v.compare(width, "eq", source, v.const(0));
    const scan = bitScanIndex(v, op, source);
    const scanOrZero = v.select(sourceIsZero, v.const(0), scan);
    const result = v.select(sourceIsZero, oldDestination, scan);

    writeBitScanFlags(s, v, sourceIsZero, scanOrZero);
    s.set(dst, result, width);
  };
}

function bitStringMemorySemantic(
  s: SemanticsBuilder,
  v: Values,
  op: BitTestOp,
  width: BitFieldWidth,
  dst: OperandRef
): void {
  const offset = s.get(s.operand(1), width, { signed: true });
  const element = v.binary("shr_s", offset, v.const(elementShift(width)));
  const byteOffset = v.binary("shl", element, v.const(byteShift(width)));
  const memory = s.operandMem(dst, byteOffset);
  const bitIndex = v.binary("and", offset, v.const(width - 1));

  if (op === "bt") {
    const access = resolveMemoryAccess(s, memory, v.const(width / 8), "read");
    const value = v.truncate(width, s.memoryRead(access, v.const(0), width));

    writeBitTestFlag(s, v, value, bitIndex);
    return;
  }

  const access = resolveMemoryAccess(s, memory, v.const(width / 8), "write");
  const value = v.truncate(width, s.memoryRead(access, v.const(0), width));

  writeBitTestResult(
    s,
    v,
    op,
    width,
    { kind: "memory", access },
    value,
    bitIndex
  );
}

function writeBitTestResult(
  s: SemanticsBuilder,
  v: Values,
  op: Exclude<BitTestOp, "bt">,
  width: BitFieldWidth,
  target: ResolvedStorageAccess<"write">,
  value: Value,
  bitIndex: Value
): void {
  writeBitTestFlag(s, v, value, bitIndex);

  writeStorage(s, v, target, bitTestWriteResult(v, op, width, value, bitIndex), width);
}

function writeBitTestFlag(
  s: SemanticsBuilder,
  v: Values,
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
  v: Values,
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
      return v.truncate(width, v.binary("and", value, v.binary("xor", mask, v.const(widthMask(width)))));
    case "btc":
      return v.truncate(width, v.binary("xor", value, mask));
  }
}

function simpleBitIndex(
  s: SemanticsBuilder,
  v: Values,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource
): Value {
  const raw = offsetSource === "reg"
    ? s.get(s.operand(1), width)
    : s.get(s.operand(1), 8);

  return v.binary("and", raw, v.const(width - 1));
}

function bitScanIndex(v: Values, op: BitScanOp, source: Value): Value {
  switch (op) {
    case "bsf":
      return v.unary("ctz", source);
    case "bsr":
      return v.binary("sub", v.const(31), v.unary("clz", source));
  }
}

function writeBitScanFlags(
  s: SemanticsBuilder,
  v: Values,
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

function parityFlag(v: Values, value: ValueInput): Value {
  const lowByte = v.binary("and", value, v.const(0xff));
  const odd = lowBit(v, v.unary("popcnt", lowByte));

  return v.compare(32, "eq", odd, v.const(0));
}

function lowBit(v: Values, value: ValueInput): Value {
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
