import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator,
  ZeroTestOperator
} from "#compiler/function/values/integer/operators.js";
import { normalizeInteger, type IntegerWidth } from "#compiler/function/values/integer/width.js";

export function evaluateBinary(
  operator: BinaryOperator,
  width: IntegerWidth,
  left: bigint,
  right: bigint
): bigint | undefined {
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

      if (divisor === 0n || (width >= 32 && divisor === -1n && dividend === minimumSigned(width))) {
        return undefined;
      }
      return normalizeInteger(width, dividend / divisor);
    }
    case "div_u":
      return right === 0n ? undefined : normalizeInteger(width, left / right);
    case "rem_s": {
      const divisor = signedInteger(width, right);

      return divisor === 0n
        ? undefined
        : normalizeInteger(width, signedInteger(width, left) % divisor);
    }
    case "rem_u":
      return right === 0n ? undefined : normalizeInteger(width, left % right);
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
      return rotateLeft(width, left, effectiveRotateAmount(width, right));
    case "rotr":
      return rotateRight(width, left, effectiveRotateAmount(width, right));
  }
}

export function evaluateComparison(
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

export function evaluateZeroTest(operator: ZeroTestOperator, value: bigint): boolean {
  return operator === "eqz" ? value === 0n : value !== 0n;
}

export function evaluateBitCount(
  operator: BitCountOperator,
  width: IntegerWidth,
  value: bigint
): bigint {
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
      return value === 0n ? BigInt(width) : trailingZeroes(value);
    case "clz":
      return BigInt(width - bitLength(value));
  }
}

export function evaluateExtension(
  width: IntegerWidth,
  sourceWidth: IntegerWidth,
  signed: boolean,
  value: bigint
): bigint {
  return normalizeInteger(width, signed ? signedInteger(sourceWidth, value) : value);
}

export function evaluateTruncation(width: IntegerWidth, value: bigint): bigint {
  return normalizeInteger(width, value);
}

export function effectiveShiftAmount(width: IntegerWidth, value: bigint): number {
  return Number(value & (width === 64 ? 63n : 31n));
}

export function effectiveRotateAmount(width: IntegerWidth, value: bigint): number {
  return Number(value % BigInt(width));
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

function signedInteger(width: IntegerWidth, value: bigint): bigint {
  return BigInt.asIntN(width, value);
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
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
