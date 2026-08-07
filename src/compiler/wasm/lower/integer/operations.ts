import { assert } from "#common/assert.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import { compareIsSigned } from "#compiler/function/values/integer/operators.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { StorageWidth } from "#compiler/function/resource.js";
import type { IntegerRecord } from "#compiler/function/values/record.js";
import type { IntegerRef } from "#compiler/function/values/reference.js";
import type { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmIntegerType } from "#compiler/wasm/type-lowering.js";
import type { LowBits } from "./low-bits.js";

export type IntegerView = "unsigned" | "signed";

type IntegerOperation = Extract<
  IntegerRecord,
  {
    op:
      | "integer.constant"
      | "integer.unreachable"
      | "integer.binary"
      | "integer.compare"
      | "integer.truncate"
      | "integer.extend"
      | "integer.bitCount";
  }
>;

type IntegerLoweringResult = Readonly<{
  base: WasmValueId;
  normalizedAs?: IntegerView;
}>;

export type IntegerLowering = Readonly<{
  wasm: WasmValuesBuilder;
  lowBits: LowBits;
  lower(value: IntegerRef): WasmValueId;
  normalize(value: IntegerRef, view: IntegerView): WasmValueId;
}>;

export function lowerIntegerOperation(
  record: IntegerOperation,
  lowering: IntegerLowering
): IntegerLoweringResult {
  switch (record.op) {
    case "integer.constant":
      return {
        base:
          record.width === 64
            ? lowering.wasm.constant64(BigInt.asIntN(64, record.attr))
            : lowering.wasm.constant(Number(BigInt.asIntN(32, record.attr)))
      };
    case "integer.unreachable":
      return { base: lowering.wasm.unreachable(wasmIntegerType(record.width)) };
    case "integer.binary":
      return lowerBinary(record.attr, record.a, record.b, lowering);
    case "integer.compare":
      return {
        base: lowerComparison(record.attr, record.a, record.b, lowering)
      };
    case "integer.truncate": {
      const lowBits = lowering.lowBits.lower(record.a, record.width);

      return {
        base: record.a.width < 64 ? lowBits : lowering.wasm.convert("wrap_i64", lowBits)
      };
    }
    case "integer.extend": {
      const view = record.attr ? "signed" : "unsigned";

      return record.width < 64
        ? { base: lowering.normalize(record.a, view), normalizedAs: view }
        : {
            base: lowering.wasm.convert(
              record.attr ? "extend_i32_s" : "extend_i32_u",
              lowering.normalize(record.a, view)
            )
          };
    }
    case "integer.bitCount":
      return lowerBitCount(record.attr, record.a, lowering);
  }
}

export function normalizeInteger(
  wasm: WasmValuesBuilder,
  width: 1 | 8 | 16,
  value: WasmValueId,
  view: IntegerView
): WasmValueId {
  if (width === 1) {
    const bit = wasm.binary("and", value, wasm.constant(1));

    return view === "unsigned" ? bit : wasm.binary("sub", wasm.constant(0), bit);
  }
  return view === "unsigned"
    ? wasm.binary("and", value, wasm.constant(width === 8 ? 0xff : 0xffff))
    : wasm.unary(width === 8 ? "extend8_s" : "extend16_s", value);
}

function lowerBinary(
  operator: BinaryOperator,
  a: IntegerRef,
  b: IntegerRef,
  lowering: IntegerLowering
): IntegerLoweringResult {
  const width = a.width;
  const { wasm, lowBits, lower, normalize } = lowering;

  switch (operator) {
    case "div_u":
    case "rem_u":
      return {
        base: wasm.binary(operator, normalize(a, "unsigned"), normalize(b, "unsigned")),
        normalizedAs: "unsigned"
      };
    case "div_s":
      return {
        base: wasm.binary(operator, normalize(a, "signed"), normalize(b, "signed"))
      };
    case "rem_s":
      return {
        base: wasm.binary(operator, normalize(a, "signed"), normalize(b, "signed")),
        normalizedAs: "signed"
      };
    case "shr_u":
    case "shr_s": {
      const type = wasmIntegerType(width);
      const view = operator === "shr_u" ? "unsigned" : "signed";

      return {
        base: wasm.binary(operator, normalize(a, view), lowBits.lowerShiftCount(b, type)),
        normalizedAs: view
      };
    }
    case "shl": {
      const type = wasmIntegerType(width);

      return {
        base: wasm.binary(operator, lower(a), lowBits.lowerShiftCount(b, type))
      };
    }
    case "rotl":
    case "rotr":
      return {
        base: isNarrowWidth(width)
          ? lowerNarrowRotate(width, operator, a, b, lowering)
          : wasm.binary(operator, lower(a), lowBits.lowerShiftCount(b, wasmIntegerType(width)))
      };
    case "add":
    case "sub":
    case "mul":
    case "xor":
    case "or":
      return { base: wasm.binary(operator, lower(a), lower(b)) };
    case "and":
      return { base: lowBits.lowerAnd(a, b, width) };
  }
}

function lowerComparison(
  operator: CompareOperator,
  a: IntegerRef,
  b: IntegerRef,
  lowering: IntegerLowering
): WasmValueId {
  const width = a.width;
  const { wasm, lower, normalize } = lowering;

  if (isNarrowWidth(width) && (operator === "eq" || operator === "ne")) {
    const left = lower(a);
    const right = lower(b);
    const leftIsZeroFilled = wasm.requiredBits(left).unsigned <= width;
    const rightIsZeroFilled = wasm.requiredBits(right).unsigned <= width;

    if (leftIsZeroFilled || rightIsZeroFilled) {
      return wasm.compare(
        operator,
        leftIsZeroFilled ? left : normalize(a, "unsigned"),
        rightIsZeroFilled ? right : normalize(b, "unsigned")
      );
    }
    const difference = wasm.binary("xor", left, right);
    const normalized = normalizeInteger(wasm, width, difference, "signed");
    const equal = wasm.eqz(normalized);

    return operator === "eq" ? equal : wasm.eqz(equal);
  }

  const left =
    operator === "eq" || operator === "ne"
      ? lower(a)
      : normalize(a, compareIsSigned(operator) ? "signed" : "unsigned");
  const right =
    operator === "eq" || operator === "ne"
      ? lower(b)
      : normalize(b, compareIsSigned(operator) ? "signed" : "unsigned");

  return wasm.compare(operator, left, right);
}

function lowerBitCount(
  operator: BitCountOperator,
  value: IntegerRef,
  lowering: IntegerLowering
): IntegerLoweringResult {
  const { wasm, lower, normalize } = lowering;
  const width = value.width;
  let base: WasmValueId;

  if (width === 32 || width === 64) {
    base = wasm.unary(operator, lower(value));
  } else {
    switch (operator) {
      case "popcnt":
        base = wasm.unary(operator, normalize(value, "unsigned"));
        break;
      case "ctz":
        base = wasm.unary(operator, wasm.binary("or", lower(value), wasm.constant(1 << width)));
        break;
      case "clz":
        base = wasm.binary(
          "sub",
          wasm.unary(operator, normalize(value, "unsigned")),
          wasm.constant(32 - width)
        );
        break;
    }
  }
  return { base, ...(width < 32 ? { normalizedAs: "unsigned" as const } : {}) };
}

function lowerNarrowRotate(
  width: 1 | StorageWidth,
  operator: "rotl" | "rotr",
  value: IntegerRef,
  count: IntegerRef,
  lowering: IntegerLowering
): WasmValueId {
  assert(width < 32, `narrow rotate requires a sub-32-bit value, got ${width}`);
  const { wasm, lowBits, normalize } = lowering;
  const source = normalize(value, "unsigned");
  const wasmCount = lowBits.lowerShiftCount(count, "i32");
  const maskedCount = wasm.binary("and", wasmCount, wasm.constant(width - 1));
  const complement = wasm.binary("sub", wasm.constant(width), maskedCount);
  const leftCount = operator === "rotl" ? maskedCount : complement;
  const rightCount = operator === "rotl" ? complement : maskedCount;
  const left = wasm.binary("shl", source, leftCount);
  const right = wasm.binary("shr_u", source, rightCount);

  return wasm.binary("or", left, right);
}

function isNarrowWidth(width: IntegerWidth): width is 1 | 8 | 16 {
  return width < 32;
}
