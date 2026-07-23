import { assert } from "#common/assert.js";
import { i32 } from "#common/numeric.js";
import type { BinaryDefinition, BinaryTrapCase } from "./binary.js";
import { fitsUnsigned, unboundedWidthBounds } from "./width-bounds.js";

export type BinaryArithmeticOperator =
  | "add"
  | "sub"
  | "mul"
  | "div_s"
  | "div_u"
  | "rem_s"
  | "rem_u";

export const binaryArithmetic: Readonly<
  Record<BinaryArithmeticOperator, BinaryDefinition>
> = {
  add: {
    evaluate: (a, b) => i32(a + b),
    fold: ({ a, b, left, right }) => right === 0 ? a : left === 0 ? b : undefined,
    bounds: unboundedWidthBounds
  },
  sub: {
    evaluate: (a, b) => i32(a - b),
    fold: ({ context, a, b, right }) => {
      if (right === 0) {
        return a;
      }

      return a === b
        ? context.constant(0)
        : undefined;
    },
    bounds: unboundedWidthBounds
  },
  mul: {
    evaluate: Math.imul,
    fold: ({ context, a, b, left, right }) => {
      if (right === 1) {
        return a;
      }

      if (left === 1) {
        return b;
      }

      if (right === 0) {
        return context.constant(0);
      }

      return left === 0
        ? context.constant(0)
        : undefined;
    },
    bounds: unboundedWidthBounds
  },
  div_s: {
    evaluate: (a, b) => {
      assert(b !== 0, "div_s divisor must be non-zero");
      assert(a !== -0x8000_0000 || b !== -1, "div_s quotient must not overflow");
      return i32(Math.trunc(a / b));
    },
    fold: ({ a, right }) => right === 1 ? a : undefined,
    bounds: unboundedWidthBounds,
    mayTrap: ({ context, type, a, b }) => {
      const divisor = context.integerValue(b);

      if (divisor === undefined || divisor === 0n) {
        return true;
      }

      if (divisor !== -1n) {
        return false;
      }

      const dividend = context.integerValue(a);
      const minimum = type === "i32" ? -0x8000_0000n : -0x8000_0000_0000_0000n;

      return dividend === undefined || dividend === minimum;
    }
  },
  div_u: {
    evaluate: (a, b) => {
      assert((b >>> 0) !== 0, "div_u divisor must be non-zero");
      return i32(Math.floor((a >>> 0) / (b >>> 0)));
    },
    fold: ({ a, right }) => right === 1 ? a : undefined,
    bounds: ({ context, a }) => fitsUnsigned(context.widthBounds(a).unsignedBits),
    mayTrap: zeroDivisorMayTrap
  },
  rem_s: {
    evaluate: (a, b) => {
      assert(b !== 0, "rem_s divisor must be non-zero");
      return i32(a % b);
    },
    fold: ({ context, right }) =>
      right === 1 || right === -1
        ? context.constant(0)
        : undefined,
    bounds: unboundedWidthBounds,
    mayTrap: zeroDivisorMayTrap
  },
  rem_u: {
    evaluate: (a, b) => {
      assert((b >>> 0) !== 0, "rem_u divisor must be non-zero");
      return i32((a >>> 0) % (b >>> 0));
    },
    fold: ({ context, right }) => right === 1
      ? context.constant(0)
      : undefined,
    bounds: ({ context, b }) => fitsUnsigned(context.widthBounds(b).unsignedBits),
    mayTrap: zeroDivisorMayTrap
  }
};

function zeroDivisorMayTrap({ context, b }: BinaryTrapCase): boolean {
  const divisor = context.integerValue(b);

  return divisor === undefined || divisor === 0n;
}
