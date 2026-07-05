import type {
  SemanticBuildContext,
  SemanticsBuilder,
  SemanticTemplate
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
  return (s, context) => {
    const dst = s.operand(0);
    const dstStorage = resolvedOperandStorage(context, dst);

    if (dstStorage === "mem" && offsetSource === "reg") {
      bitStringMemorySemantic(s, op, width, dst);
      return;
    }

    if (dstStorage === "mem") {
      guardBitTestAccess(s, context, op, dst, width);
    }

    const value = s.truncate(width, s.get(dst, width));
    const bitIndex = simpleBitIndex(s, width, offsetSource);

    writeBitTestResult(s, op, width, dst, value, bitIndex);
  };
}

export function bitScanSemantic(op: BitScanOp, width: BitFieldWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);

    const source = s.truncate(width, s.get(src, width));
    const oldDestination = s.get(dst, width);
    const sourceIsZero = s.compare(width, "eq", source, s.const32(0));
    const scan = bitScanIndex(s, op, source);
    const scanOrZero = s.select(sourceIsZero, s.const32(0), scan);
    const result = s.select(sourceIsZero, oldDestination, scan);

    writeBitScanFlags(s, sourceIsZero, scanOrZero);
    s.set(dst, result, width);
  };
}

function bitStringMemorySemantic(
  s: SemanticsBuilder,
  op: BitTestOp,
  width: BitFieldWidth,
  dst: OperandRef
): void {
  const offset = s.get(s.operand(1), width, { signed: true });
  const element = s.binary("shr_s", offset, s.const32(elementShift(width)));
  const byteOffset = s.binary("shl", element, s.const32(byteShift(width)));
  const address = s.binary("add", s.linearAddress(dst), byteOffset);

  guardAddressBitTestAccess(s, op, address, width);

  const storage = s.mem(address);
  const value = s.truncate(width, s.get(storage, width));
  const bitIndex = s.binary("and", offset, s.const32(width - 1));

  writeBitTestResult(s, op, width, storage, value, bitIndex);
}

function writeBitTestResult(
  s: SemanticsBuilder,
  op: BitTestOp,
  width: BitFieldWidth,
  target: StorageInput,
  value: Value,
  bitIndex: Value
): void {
  const bit = lowBit(s, s.binary("shr_u", value, bitIndex));

  // BT/BTS/BTR/BTC define CF only. PF/AF/ZF/SF/OF are architecturally
  // undefined; the local hardware probe preserves them, so leave them
  // untouched by writing only CF.
  s.writeFlag("CF", bit);

  if (op === "bt") {
    return;
  }

  s.set(target, bitTestWriteResult(s, op, width, value, bitIndex), width);
}

function bitTestWriteResult(
  s: SemanticsBuilder,
  op: Exclude<BitTestOp, "bt">,
  width: BitFieldWidth,
  value: Value,
  bitIndex: Value
): Value {
  const mask = s.truncate(width, s.binary("shl", s.const32(1), bitIndex));

  switch (op) {
    case "bts":
      return s.truncate(width, s.binary("or", value, mask));
    case "btr":
      return s.truncate(width, s.binary("and", value, s.binary("xor", mask, s.const32(widthMask(width)))));
    case "btc":
      return s.truncate(width, s.binary("xor", value, mask));
  }
}

function simpleBitIndex(
  s: SemanticsBuilder,
  width: BitFieldWidth,
  offsetSource: BitOffsetSource
): Value {
  const raw = offsetSource === "reg"
    ? s.get(s.operand(1), width)
    : s.get(s.operand(1), 8);

  return s.binary("and", raw, s.const32(width - 1));
}

function bitScanIndex(s: SemanticsBuilder, op: BitScanOp, source: Value): Value {
  switch (op) {
    case "bsf":
      return s.unary("ctz", source);
    case "bsr":
      return s.binary("sub", s.const32(31), s.unary("clz", source));
  }
}

function writeBitScanFlags(
  s: SemanticsBuilder,
  sourceIsZero: Value,
  scanOrZero: Value
): void {
  const zero = s.const32(0);
  const parity = parityFlag(s, scanOrZero);

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

function parityFlag(s: SemanticsBuilder, value: ValueInput): Value {
  const lowByte = s.binary("and", value, s.const32(0xff));
  const odd = lowBit(s, s.unary("popcnt", lowByte));

  return s.compare(32, "eq", odd, s.const32(0));
}

function lowBit(s: SemanticsBuilder, value: ValueInput): Value {
  return s.binary("and", value, s.const32(1));
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
