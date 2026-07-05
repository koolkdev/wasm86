import { assert } from "#common/assert.js";
import { i32 } from "#x86/numeric.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";
import type { OperandWidth } from "#x86/types.js";
import type { ValueId, ValueType } from "./values.js";

export type ValueFoldBounds = Readonly<{ unsignedBits: number; signedBits: number }>;

export type ValueFoldContext = Readonly<{
  constValue(id: ValueId): number | undefined;
  const(value: number): ValueId;
  unreachable(type: ValueType): ValueId;
  widthBounds(id: ValueId): ValueFoldBounds;
}>;

export function foldBinary(
  context: ValueFoldContext,
  operator: BinaryOperator,
  a: ValueId,
  b: ValueId
): ValueId | undefined {
  const left = context.constValue(a);
  const right = context.constValue(b);

  if (left !== undefined && right !== undefined) {
    if (constantBinaryTraps(operator, left, right)) {
      return context.unreachable("i32");
    }

    return context.const(evalBinary(operator, left, right));
  }

  switch (operator) {
    case "add":
      if (right === 0) {
        return a;
      }

      if (left === 0) {
        return b;
      }

      return undefined;
    case "sub":
      if (right === 0) {
        return a;
      }

      if (a === b) {
        return context.const(0);
      }

      return undefined;
    case "mul":
      if (right === 1) {
        return a;
      }

      if (left === 1) {
        return b;
      }

      if (right === 0 || left === 0) {
        return context.const(0);
      }

      return undefined;
    case "div_s":
    case "div_u":
      if (right === 1) {
        return a;
      }

      return undefined;
    case "rem_s":
      if (right === 1 || right === -1) {
        return context.const(0);
      }

      return undefined;
    case "rem_u":
      if (right === 1) {
        return context.const(0);
      }

      return undefined;
    case "xor":
      if (right === 0) {
        return a;
      }

      if (left === 0) {
        return b;
      }

      if (a === b) {
        return context.const(0);
      }

      return undefined;
    case "or":
      if (right === 0 || a === b) {
        return a;
      }

      if (left === 0) {
        return b;
      }

      if (right === -1 || left === -1) {
        return context.const(-1);
      }

      return undefined;
    case "and":
      if (right === -1 || a === b) {
        return a;
      }

      if (left === -1) {
        return b;
      }

      if (right === 0 || left === 0) {
        return context.const(0);
      }

      return undefined;
    case "shl":
    case "rotl":
    case "rotr":
    case "shr_s":
    case "shr_u":
      if (right !== undefined && (right & 31) === 0) {
        return a;
      }

      if (left === 0) {
        return context.const(0);
      }

      return undefined;
  }
}

export function foldUnary(
  context: ValueFoldContext,
  operator: UnaryOperator,
  value: ValueId
): ValueId | undefined {
  const constant = context.constValue(value);

  if (constant === undefined) {
    return undefined;
  }

  return context.const(evalUnary(operator, constant));
}

export function foldCompare(
  context: ValueFoldContext,
  operator: CompareOperator,
  a: ValueId,
  b: ValueId
): ValueId | undefined {
  const left = context.constValue(a);
  const right = context.constValue(b);

  if (left !== undefined && right !== undefined) {
    return context.const(evalCompare(operator, left, right) ? 1 : 0);
  }

  if (a !== b) {
    return undefined;
  }

  switch (operator) {
    case "eq":
    case "le_u":
    case "ge_u":
    case "le_s":
    case "ge_s":
      return context.const(1);
    case "ne":
    case "lt_u":
    case "gt_u":
    case "lt_s":
    case "gt_s":
      return context.const(0);
  }
}

export function foldSelect(
  context: ValueFoldContext,
  condition: ValueId,
  whenTrue: ValueId,
  whenFalse: ValueId
): ValueId | undefined {
  if (whenTrue === whenFalse) {
    return whenTrue;
  }

  const constant = context.constValue(condition);

  if (constant === undefined) {
    return undefined;
  }

  return constant === 0 ? whenFalse : whenTrue;
}

export function foldTruncate(
  context: ValueFoldContext,
  width: OperandWidth,
  value: ValueId
): ValueId | undefined {
  const constant = context.constValue(value);

  if (constant !== undefined) {
    return context.const(truncateConst(width, constant));
  }

  return width === 32 || context.widthBounds(value).unsignedBits <= width
    ? value
    : undefined;
}

export function foldExtend(
  context: ValueFoldContext,
  width: OperandWidth,
  value: ValueId
): ValueId | undefined {
  const constant = context.constValue(value);

  if (constant !== undefined) {
    return context.const(extendConst(width, constant));
  }

  return width === 32 || context.widthBounds(value).signedBits <= width
    ? value
    : undefined;
}

function evalBinary(operator: BinaryOperator, a: number, b: number): number {
  switch (operator) {
    case "add":
      return i32(a + b);
    case "sub":
      return i32(a - b);
    case "mul":
      return Math.imul(a, b);
    case "div_s": {
      assert(b !== 0, "div_s divisor must be non-zero");
      assert(a !== -0x8000_0000 || b !== -1, "div_s quotient must not overflow");
      return i32(Math.trunc(a / b));
    }
    case "div_u": {
      assert((b >>> 0) !== 0, "div_u divisor must be non-zero");
      return i32(Math.floor((a >>> 0) / (b >>> 0)));
    }
    case "rem_s": {
      assert(b !== 0, "rem_s divisor must be non-zero");
      return i32(a % b);
    }
    case "rem_u": {
      assert((b >>> 0) !== 0, "rem_u divisor must be non-zero");
      return i32((a >>> 0) % (b >>> 0));
    }
    case "xor":
      return a ^ b;
    case "or":
      return a | b;
    case "and":
      return a & b;
    case "shl":
      return a << (b & 31);
    case "rotl":
      return rotateLeft32(a, b);
    case "rotr":
      return rotateRight32(a, b);
    case "shr_s":
      return a >> (b & 31);
    case "shr_u":
      return i32(a >>> (b & 31));
  }
}

function constantBinaryTraps(operator: BinaryOperator, left: number, right: number): boolean {
  switch (operator) {
    case "div_s":
      return right === 0 || (left === -0x8000_0000 && right === -1);
    case "div_u":
    case "rem_s":
    case "rem_u":
      return right === 0;
    case "add":
    case "sub":
    case "mul":
    case "xor":
    case "or":
    case "and":
    case "shl":
    case "rotl":
    case "rotr":
    case "shr_s":
    case "shr_u":
      return false;
  }
}

function rotateLeft32(value: number, count: number): number {
  const shift = count & 31;

  return i32((value << shift) | (value >>> ((32 - shift) & 31)));
}

function rotateRight32(value: number, count: number): number {
  const shift = count & 31;

  return i32((value >>> shift) | (value << ((32 - shift) & 31)));
}

function evalUnary(operator: UnaryOperator, value: number): number {
  switch (operator) {
    case "popcnt":
      return popCount32(value);
    case "ctz":
      return countTrailingZeros32(value);
    case "clz":
      return Math.clz32(value);
  }
}

function truncateConst(width: OperandWidth, value: number): number {
  switch (width) {
    case 8:
      return value & 0xff;
    case 16:
      return value & 0xffff;
    case 32:
      return i32(value);
  }
}

function extendConst(width: OperandWidth, value: number): number {
  switch (width) {
    case 8:
      return (value << 24) >> 24;
    case 16:
      return (value << 16) >> 16;
    case 32:
      return i32(value);
  }
}

function evalCompare(operator: CompareOperator, a: number, b: number): boolean {
  switch (operator) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt_u":
      return (a >>> 0) < (b >>> 0);
    case "le_u":
      return (a >>> 0) <= (b >>> 0);
    case "gt_u":
      return (a >>> 0) > (b >>> 0);
    case "ge_u":
      return (a >>> 0) >= (b >>> 0);
    case "lt_s":
      return a < b;
    case "le_s":
      return a <= b;
    case "gt_s":
      return a > b;
    case "ge_s":
      return a >= b;
  }
}

function popCount32(value: number): number {
  let remaining = value >>> 0;
  let count = 0;

  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }

  return count;
}

function countTrailingZeros32(value: number): number {
  const unsigned = value >>> 0;

  return unsigned === 0 ? 32 : 31 - Math.clz32(unsigned & -unsigned);
}
