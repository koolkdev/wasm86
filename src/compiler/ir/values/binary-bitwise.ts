import { i32 } from "#common/numeric.js";
import type { BinaryBoundsCase, BinaryDefinition, BinaryFoldCase } from "./binary.js";
import type { WidthBounds } from "./types.js";
import { clampedBounds, fitsUnsigned, unboundedWidthBounds } from "./width-bounds.js";

export type BinaryBitwiseOperator =
  "xor" | "or" | "and" | "shl" | "rotl" | "rotr" | "shr_s" | "shr_u";

export const binaryBitwise: Readonly<Record<BinaryBitwiseOperator, BinaryDefinition>> = {
  xor: {
    evaluate: (a, b) => a ^ b,
    fold: ({ context, a, b, left, right }) => {
      if (right === 0) {
        return a;
      }

      if (left === 0) {
        return b;
      }

      return a === b ? context.constant(0) : undefined;
    },
    bounds: bitwiseBounds
  },
  or: {
    evaluate: (a, b) => a | b,
    fold: ({ context, a, b, left, right }) => {
      if (right === 0 || a === b) {
        return a;
      }

      if (left === 0) {
        return b;
      }

      if (right === -1) {
        return context.constant(-1);
      }

      return left === -1 ? context.constant(-1) : undefined;
    },
    bounds: bitwiseBounds
  },
  and: {
    evaluate: (a, b) => a & b,
    fold: ({ context, a, b, left, right }) => {
      if (right === -1 || a === b) {
        return a;
      }

      if (left === -1) {
        return b;
      }

      if (right === 0) {
        return context.constant(0);
      }

      return left === 0 ? context.constant(0) : undefined;
    },
    bounds: ({ context, a, b }) => {
      const left = context.widthBounds(a);
      const right = context.widthBounds(b);

      return clampedBounds(
        Math.min(left.unsignedBits, right.unsignedBits),
        Math.max(left.signedBits, right.signedBits)
      );
    }
  },
  shl: {
    evaluate: (a, b) => a << (b & 31),
    fold: foldShift,
    bounds: unboundedWidthBounds
  },
  rotl: {
    evaluate: (a, b) => {
      const shift = b & 31;

      return i32((a << shift) | (a >>> ((32 - shift) & 31)));
    },
    fold: foldShift,
    bounds: unboundedWidthBounds
  },
  rotr: {
    evaluate: (a, b) => {
      const shift = b & 31;

      return i32((a >>> shift) | (a << ((32 - shift) & 31)));
    },
    fold: foldShift,
    bounds: unboundedWidthBounds
  },
  shr_s: {
    evaluate: (a, b) => a >> (b & 31),
    fold: foldShift,
    bounds: unboundedWidthBounds
  },
  shr_u: {
    evaluate: (a, b) => i32(a >>> (b & 31)),
    fold: foldShift,
    bounds: ({ context, a, b }) => {
      const left = context.widthBounds(a);
      const shift = context.constValue(b);

      return shift === undefined
        ? clampedBounds(left.unsignedBits, 32)
        : fitsUnsigned(Math.max(1, left.unsignedBits - (shift & 31)));
    }
  }
};

function bitwiseBounds({ context, a, b }: BinaryBoundsCase): WidthBounds {
  const left = context.widthBounds(a);
  const right = context.widthBounds(b);

  return clampedBounds(
    Math.max(left.unsignedBits, right.unsignedBits),
    Math.max(left.signedBits, right.signedBits)
  );
}

function foldShift({ context, a, left, right }: BinaryFoldCase) {
  if (right !== undefined && (right & 31) === 0) {
    return a;
  }

  return left === 0 ? context.constant(0) : undefined;
}
