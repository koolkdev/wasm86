import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import {
  bitLength,
  effectiveShiftAmount,
  type IntegerWidth
} from "#compiler/function/values/integer/width.js";
import type { FoldOutcome } from "../expression.js";
import type { ValueRecord, ZeroTestOperator } from "../record.js";

export type OperandFact = Readonly<{ constant: bigint | undefined }>;

export function integerConstantOf(record: ValueRecord | undefined): bigint | undefined {
  return record?.op === "integer.constant" ? record.attr : undefined;
}

export function integerOperandFact(record: ValueRecord | undefined): OperandFact {
  return { constant: integerConstantOf(record) };
}

const operandA: FoldOutcome = { kind: "operand", which: "a" };
const operandB: FoldOutcome = { kind: "operand", which: "b" };
const operandC: FoldOutcome = { kind: "operand", which: "c" };
const unreachableOutcome: FoldOutcome = { kind: "unreachable" };

export function normalizeInteger(width: IntegerWidth, value: number | bigint): bigint {
  return BigInt.asUintN(width, BigInt(value));
}

export function signedInteger(width: IntegerWidth, value: bigint): bigint {
  return BigInt.asIntN(width, value);
}

// aIsB is semantic value identity, never object identity.
export function foldBinary(
  operator: BinaryOperator,
  width: IntegerWidth,
  a: OperandFact,
  b: OperandFact,
  aIsB: boolean
): FoldOutcome {
  const left = a.constant;
  const right = b.constant;

  if (left !== undefined && right !== undefined) {
    if (binaryConstantIsUndefined(operator, width, left, right)) {
      return unreachableOutcome;
    }

    return constantOutcome(evaluateDefinedBinary(operator, width, left, right));
  }

  switch (operator) {
    case "add":
      return right === 0n ? operandA : left === 0n ? operandB : undefined;
    case "sub":
      if (right === 0n) {
        return operandA;
      }
      return aIsB ? constantOutcome(0n) : undefined;
    case "mul":
      if (right === 1n) {
        return operandA;
      }
      if (left === 1n) {
        return operandB;
      }
      return right === 0n || left === 0n ? constantOutcome(0n) : undefined;
    case "div_s":
    case "div_u":
      return right === 1n ? operandA : undefined;
    case "rem_s":
      return right === 1n || right === normalizeInteger(width, -1n)
        ? constantOutcome(0n)
        : undefined;
    case "rem_u":
      return right === 1n ? constantOutcome(0n) : undefined;
    case "xor":
      if (right === 0n) {
        return operandA;
      }
      if (left === 0n) {
        return operandB;
      }
      return aIsB ? constantOutcome(0n) : undefined;
    case "or":
      if (right === 0n || aIsB) {
        return operandA;
      }
      if (left === 0n) {
        return operandB;
      }
      if (right === normalizeInteger(width, -1n)) {
        return operandB;
      }
      return left === normalizeInteger(width, -1n) ? operandA : undefined;
    case "and":
      if (aIsB || right === normalizeInteger(width, -1n)) {
        return operandA;
      }
      if (left === normalizeInteger(width, -1n)) {
        return operandB;
      }
      if (right === 0n || left === 0n) {
        return constantOutcome(0n);
      }
      return undefined;
    case "shl":
    case "shr_s":
    case "shr_u":
      if (right !== undefined && effectiveShiftAmount(width, right) === 0) {
        return operandA;
      }
      return left === 0n ? constantOutcome(0n) : undefined;
    case "rotl":
    case "rotr":
      return right !== undefined && rotateAmount(width, right) === 0 ? operandA : undefined;
  }
}

// Order is load-bearing: constants, then value identity, then the zero rewrites.
export function foldComparison(
  operator: CompareOperator,
  width: IntegerWidth,
  a: OperandFact,
  b: OperandFact,
  aIsB: boolean
): FoldOutcome {
  const left = a.constant;
  const right = b.constant;

  if (left !== undefined && right !== undefined) {
    return constantOutcome(evaluateComparison(operator, width, left, right) ? 1n : 0n);
  }
  if (aIsB) {
    return constantOutcome(sameValueResult(operator) ? 1n : 0n);
  }
  if (operator === "eq" || operator === "ne") {
    const zeroTest: ZeroTestOperator = operator === "eq" ? "eqz" : "nonzero";

    if (left === 0n) {
      return { kind: "zeroTest", operator: zeroTest, operand: "b" };
    }
    if (right === 0n) {
      return { kind: "zeroTest", operator: zeroTest, operand: "a" };
    }
  }
  return undefined;
}

// The width-1 collapse precedes the constant check, so this fold can forward to a constant.
export function foldZeroTest(
  operator: ZeroTestOperator,
  width: IntegerWidth,
  value: OperandFact
): FoldOutcome {
  if (operator === "nonzero" && width === 1) {
    return operandA;
  }
  if (value.constant === undefined) {
    return undefined;
  }
  const result = operator === "eqz" ? value.constant === 0n : value.constant !== 0n;

  return constantOutcome(result ? 1n : 0n);
}

export function foldBitCount(
  operator: BitCountOperator,
  width: IntegerWidth,
  value: OperandFact
): FoldOutcome {
  return value.constant === undefined
    ? undefined
    : constantOutcome(evaluateBitCount(operator, width, value.constant));
}

export function foldExtend(
  width: IntegerWidth,
  sourceWidth: IntegerWidth,
  signed: boolean,
  value: OperandFact
): FoldOutcome {
  if (value.constant === undefined) {
    return undefined;
  }
  const extended = signed ? signedInteger(sourceWidth, value.constant) : value.constant;

  return constantOutcome(normalizeInteger(width, extended));
}

export function foldTruncate(width: IntegerWidth, value: OperandFact): FoldOutcome {
  return value.constant === undefined
    ? undefined
    : constantOutcome(normalizeInteger(width, value.constant));
}

// Forwards to an arm without inspecting it, so the fold target can be a constant.
export function foldSelect(condition: OperandFact, whenTrueIsWhenFalse: boolean): FoldOutcome {
  if (whenTrueIsWhenFalse) {
    return operandB;
  }
  if (condition.constant === undefined) {
    return undefined;
  }
  return condition.constant === 0n ? operandC : operandB;
}

// Constant outcomes carry the value already normalized to the outcome width.
function constantOutcome(value: bigint): FoldOutcome {
  return { kind: "constant", value };
}

function evaluateDefinedBinary(
  operator: BinaryOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): bigint {
  switch (operator) {
    case "add":
      return normalizeInteger(width, left + right);
    case "sub":
      return normalizeInteger(width, left - right);
    case "mul":
      return normalizeInteger(width, left * right);
    case "div_s": {
      const divisor = signedInteger(width, right);
      const dividend = signedInteger(width, left);

      return normalizeInteger(width, dividend / divisor);
    }
    case "div_u":
      return normalizeInteger(width, left / right);
    case "rem_s": {
      const divisor = signedInteger(width, right);

      return normalizeInteger(width, signedInteger(width, left) % divisor);
    }
    case "rem_u":
      return normalizeInteger(width, left % right);
    case "xor":
      return normalizeInteger(width, left ^ right);
    case "or":
      return normalizeInteger(width, left | right);
    case "and":
      return normalizeInteger(width, left & right);
    case "shl":
      return normalizeInteger(width, left << BigInt(effectiveShiftAmount(width, right)));
    case "shr_s":
      return normalizeInteger(
        width,
        signedInteger(width, left) >> BigInt(effectiveShiftAmount(width, right))
      );
    case "shr_u":
      return normalizeInteger(width, left >> BigInt(effectiveShiftAmount(width, right)));
    case "rotl":
      return rotateLeft(width, left, rotateAmount(width, right));
    case "rotr":
      return rotateRight(width, left, rotateAmount(width, right));
  }
}

function binaryConstantIsUndefined(
  operator: BinaryOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): boolean {
  switch (operator) {
    case "div_s":
      return (
        right === 0n ||
        (width >= 32 &&
          signedInteger(width, right) === -1n &&
          signedInteger(width, left) === minimumSigned(width))
      );
    case "div_u":
    case "rem_s":
    case "rem_u":
      return right === 0n;
    default:
      return false;
  }
}

function evaluateComparison(
  operator: CompareOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): boolean {
  switch (operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "lt_u":
      return left < right;
    case "le_u":
      return left <= right;
    case "gt_u":
      return left > right;
    case "ge_u":
      return left >= right;
    case "lt_s":
      return signedInteger(width, left) < signedInteger(width, right);
    case "le_s":
      return signedInteger(width, left) <= signedInteger(width, right);
    case "gt_s":
      return signedInteger(width, left) > signedInteger(width, right);
    case "ge_s":
      return signedInteger(width, left) >= signedInteger(width, right);
  }
}

function sameValueResult(operator: CompareOperator): boolean {
  switch (operator) {
    case "eq":
    case "le_u":
    case "ge_u":
    case "le_s":
    case "ge_s":
      return true;
    case "ne":
    case "lt_u":
    case "gt_u":
    case "lt_s":
    case "gt_s":
      return false;
  }
}

function evaluateBitCount(operator: BitCountOperator, width: IntegerWidth, value: bigint): bigint {
  switch (operator) {
    case "popcnt": {
      let remaining = value;
      let count = 0n;

      while (remaining !== 0n) {
        remaining &= remaining - 1n;
        count += 1n;
      }
      return count;
    }
    case "ctz":
      if (value === 0n) {
        return BigInt(width);
      }
      return trailingZeroes(value);
    case "clz":
      return BigInt(width - bitLength(value));
  }
}

function trailingZeroes(value: bigint): bigint {
  let remaining = value;
  let count = 0n;

  while ((remaining & 1n) === 0n) {
    remaining >>= 1n;
    count += 1n;
  }
  return count;
}

function rotateAmount(width: IntegerWidth, value: bigint): number {
  return Number(value % BigInt(width));
}

function rotateLeft(width: IntegerWidth, value: bigint, count: number): bigint {
  if (count === 0) {
    return normalizeInteger(width, value);
  }

  return normalizeInteger(width, (value << BigInt(count)) | (value >> BigInt(width - count)));
}

function rotateRight(width: IntegerWidth, value: bigint, count: number): bigint {
  if (count === 0) {
    return normalizeInteger(width, value);
  }

  return normalizeInteger(width, (value >> BigInt(count)) | (value << BigInt(width - count)));
}

function minimumSigned(width: IntegerWidth): bigint {
  return -(1n << BigInt(width - 1));
}
