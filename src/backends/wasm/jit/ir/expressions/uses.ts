import { widthMask } from "#x86/isa/types.js";
import {
  bitRangeMask,
  checkedU32Mask
} from "./builders.js";
import type {
  ExprRef,
  ExprUse
} from "./types.js";

const exact: ExprUse = Object.freeze({ kind: "exact" });
const full32: ExprUse = Object.freeze({ kind: "full32" });

export function exactUse(): ExprUse {
  return exact;
}

export function full32Use(): ExprUse {
  return full32;
}

export function bitsUse(mask: number): ExprUse {
  return Object.freeze({ kind: "bits", mask: checkedU32Mask(mask, "expression use mask") });
}

export function childUseForExpr(expr: ExprRef, childIndex: number, use: ExprUse): ExprUse {
  switch (expr.kind) {
    case "const":
    case "input":
      throw new Error(`${expr.kind} expression has no child ${childIndex}`);
    case "unary":
      assertChildIndex(expr.kind, childIndex, 1);
      return unaryChildUse(expr.op, use);
    case "binary":
      assertChildIndex(expr.kind, childIndex, 2);
      return binaryChildUse(expr, childIndex, use);
    case "select":
      assertChildIndex(expr.kind, childIndex, 3);
      if (parentUseMask(use) === 0) {
        return bitsUse(0);
      }
      return childIndex === 0 ? full32Use() : use;
    case "project":
      assertChildIndex(expr.kind, childIndex, 1);
      return bitsUse(parentUseMask(use) & widthMask(expr.width));
    case "bits":
      assertChildIndex(expr.kind, childIndex, 1);
      return bitsUse((((parentUseMask(use) & widthMask(expr.width)) << expr.offset) >>> 0));
    case "insertBits": {
      assertChildIndex(expr.kind, childIndex, 2);
      const parentMask = parentUseMask(use);
      const insertedMask = bitRangeMask(expr.offset, expr.width);

      return childIndex === 0
        ? bitsUse((parentMask & ~insertedMask) >>> 0)
        : bitsUse(((parentMask & insertedMask) >>> expr.offset) >>> 0);
    }
    case "testBit":
      assertChildIndex(expr.kind, childIndex, 1);
      return parentUseMask(use) === 0 ? bitsUse(0) : bitsUse((1 << expr.bit) >>> 0);
    case "compare":
      assertChildIndex(expr.kind, childIndex, 2);
      return parentUseMask(use) === 0 ? bitsUse(0) : full32Use();
  }
}

export function exprUseSatisfies(available: ExprUse, required: ExprUse): boolean {
  if (available.kind === "exact" || available.kind === "full32") {
    return true;
  }

  if (required.kind !== "bits") {
    return false;
  }

  return (required.mask & ~available.mask) === 0;
}

function binaryChildUse(
  expr: Extract<ExprRef, { kind: "binary" }>,
  childIndex: number,
  use: ExprUse
): ExprUse {
  const mask = parentUseMask(use);

  if (mask === 0) {
    return bitsUse(0);
  }

  switch (expr.op) {
    case "and":
      return andChildUse(expr, childIndex, use, mask);
    case "or":
    case "xor":
      return bitsUse(mask);
    case "add":
    case "sub":
      return bitsUse(carryClosureMask(mask));
    case "shl":
    case "shr_u":
      return use.kind === "bits" ? full32Use() : use;
  }
}

function andChildUse(
  expr: Extract<ExprRef, { kind: "binary" }>,
  childIndex: number,
  use: ExprUse,
  mask: number
): ExprUse {
  const other = childIndex === 0 ? expr.right : expr.left;

  if (other.kind === "const") {
    return bitsUse((mask & other.value) >>> 0);
  }

  return use.kind === "bits" ? bitsUse(mask) : use;
}

function unaryChildUse(op: Extract<ExprRef, { kind: "unary" }>["op"], use: ExprUse): ExprUse {
  const mask = parentUseMask(use);

  if (mask === 0) {
    return bitsUse(0);
  }

  switch (op) {
    case "not":
      return bitsUse(mask);
    case "neg":
      return bitsUse(carryClosureMask(mask));
    case "extend8_s":
      return bitsUse(0xff);
    case "extend16_s":
      return bitsUse(0xffff);
  }
}

function parentUseMask(use: ExprUse): number {
  switch (use.kind) {
    case "exact":
    case "full32":
      return 0xffff_ffff;
    case "bits":
      return checkedU32Mask(use.mask, "expression use mask");
  }
}

function carryClosureMask(mask: number): number {
  const checked = checkedU32Mask(mask, "expression use mask");

  if (checked === 0) {
    return 0;
  }

  const highestBit = 31 - Math.clz32(checked);

  return highestBit === 31 ? 0xffff_ffff : ((1 << (highestBit + 1)) - 1) >>> 0;
}

function assertChildIndex(kind: string, childIndex: number, count: number): void {
  if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= count) {
    throw new Error(`${kind} expression child index out of range: ${childIndex}`);
  }
}
