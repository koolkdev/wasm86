import type { FoldOutcome } from "#compiler/function/values/expression.js";
import type { ValueRecord } from "#compiler/function/values/record.js";
import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/type.js";
import type { FloatWidth } from "#compiler/function/values/float/type.js";

export function foldFloatBinary(
  operator: FloatBinaryOperator,
  width: FloatWidth,
  a: ValueRecord | undefined,
  b: ValueRecord | undefined
): FoldOutcome {
  const left = constantBitsOf(a);
  const right = constantBitsOf(b);

  if (left === undefined || right === undefined) {
    return undefined;
  }
  const result = evaluateFloat(
    operator,
    width,
    floatLiteralValue(width, left),
    floatLiteralValue(width, right)
  );

  // Wasm does not determine the payload of a NaN result, so folding one would
  // bake an implementation choice into the module.
  return Number.isNaN(result)
    ? undefined
    : { kind: "constantBits", bits: floatLiteralBits(width, result) };
}

export function foldFloatCompare(
  operator: FloatCompareOperator,
  width: FloatWidth,
  a: ValueRecord | undefined,
  b: ValueRecord | undefined
): FoldOutcome {
  const left = constantBitsOf(a);
  const right = constantBitsOf(b);

  if (left === undefined || right === undefined) {
    return undefined;
  }
  return {
    kind: "constant",
    value: compareFloat(operator, floatLiteralValue(width, left), floatLiteralValue(width, right))
      ? 1n
      : 0n
  };
}

export function floatLiteralBits(width: 32, value: number): number;
export function floatLiteralBits(width: 64, value: number): bigint;
export function floatLiteralBits(width: FloatWidth, value: number): number | bigint;
export function floatLiteralBits(width: FloatWidth, value: number): number | bigint {
  if (width === 32) {
    scratch.setFloat32(0, value);
    return scratch.getUint32(0);
  }
  scratch.setFloat64(0, value);
  return scratch.getBigUint64(0);
}

function constantBitsOf(record: ValueRecord | undefined): number | bigint | undefined {
  return record?.op === "float.constant" ? record.attr : undefined;
}

const scratch = new DataView(new ArrayBuffer(8));

function floatLiteralValue(width: FloatWidth, bits: number | bigint): number {
  if (width === 32) {
    scratch.setUint32(0, Number(bits) >>> 0);
    return scratch.getFloat32(0);
  }
  scratch.setBigUint64(0, BigInt.asUintN(64, BigInt(bits)));
  return scratch.getFloat64(0);
}

function evaluateFloat(
  operator: FloatBinaryOperator,
  width: FloatWidth,
  a: number,
  b: number
): number {
  const result = (() => {
    switch (operator) {
      case "add":
        return a + b;
      case "sub":
        return a - b;
      case "mul":
        return a * b;
      case "div":
        return a / b;
    }
  })();

  return width === 32 ? Math.fround(result) : result;
}

function compareFloat(operator: FloatCompareOperator, a: number, b: number): boolean {
  switch (operator) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
  }
}
