import type {
  SemanticBuildContext,
  SemanticsBuilder,
  SemanticTemplate,
  Values
} from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, Value, ValueInput } from "#x86/semantics/refs.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import { writeStatusFlagValues } from "./flag-writes.js";
import { guardStorageRead, guardStorageReadWrite, resolvedOperandStorage } from "./memory.js";

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

    if (dstStorage === "mem") {
      guardBitTestAccess(s, context, op, dst, width);
    }

    const value = v.truncate(width, s.get(dst, width));
    const bitIndex = simpleBitIndex(s, v, width, offsetSource);

    writeBitTestResult(s, v, op, width, dst, value, bitIndex);
  };
}

export function bitScanSemantic(op: BitScanOp, width: BitFieldWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);

    const source = v.truncate(width, s.get(src, width));
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
  const address = v.binary("add", s.linearAddress(dst), byteOffset);

  guardAddressBitTestAccess(s, op, address, width);

  const storage = s.mem(address);
  const value = v.truncate(width, s.get(storage, width));
  const bitIndex = v.binary("and", offset, v.const(width - 1));

  writeBitTestResult(s, v, op, width, storage, value, bitIndex);
}

function writeBitTestResult(
  s: SemanticsBuilder,
  v: Values,
  op: BitTestOp,
  width: BitFieldWidth,
  target: StorageInput,
  value: Value,
  bitIndex: Value
): void {
  const bit = lowBit(v, v.binary("shr_u", value, bitIndex));

  // BT/BTS/BTR/BTC define CF only. PF/AF/ZF/SF/OF are architecturally
  // undefined; the local hardware probe preserves them, so leave them
  // untouched by writing only CF.
  s.writeFlag("CF", bit);

  if (op === "bt") {
    return;
  }

  s.set(target, bitTestWriteResult(v, op, width, value, bitIndex), width);
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

function guardBitTestAccess(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  op: BitTestOp,
  storage: StorageInput,
  width: BitFieldWidth
): void {
  if (op === "bt") {
    guardStorageRead(s, context, storage, width);
    return;
  }

  guardStorageReadWrite(s, context, storage, width);
}

function guardAddressBitTestAccess(
  s: SemanticsBuilder,
  op: BitTestOp,
  address: Value,
  width: BitFieldWidth
): void {
  const byteLength = width / 8;

  s.memoryGuard(address, byteLength, "read");

  if (op !== "bt") {
    s.memoryGuard(address, byteLength, "write");
  }
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
