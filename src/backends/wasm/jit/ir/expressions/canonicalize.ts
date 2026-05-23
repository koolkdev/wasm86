import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import {
  bitRangeMask,
  exprBits,
  exprBinary,
  exprCompare,
  exprConst,
  exprInsertBits,
  exprProject,
  exprSelect,
  exprTestBit,
  exprUnary,
  assertBitIndex,
  assertBitRange
} from "./builders.js";
import type {
  ExprRef,
  JitBinaryExpr,
  JitBitsExpr,
  JitCompareExpr,
  JitInsertBitsExpr,
  JitProjectExpr,
  JitSelectExpr,
  JitTestBitExpr,
  JitUnaryExpr
} from "./types.js";
import { exprsEqual } from "./equality.js";

export function canonicalizeExpr(expr: ExprRef): ExprRef {
  switch (expr.kind) {
    case "const": {
      const value = i32(expr.value);
      return value === expr.value ? expr : exprConst(value);
    }
    case "input":
      return expr;
    case "project":
      return canonicalizeProjectExpr(expr);
    case "bits":
      return canonicalizeBitsExpr(expr);
    case "insertBits":
      return canonicalizeInsertBitsExpr(expr);
    case "binary":
      return canonicalizeBinaryExpr(expr);
    case "unary":
      return canonicalizeUnaryExpr(expr);
    case "select":
      return canonicalizeSelectExpr(expr);
    case "testBit":
      return canonicalizeTestBitExpr(expr);
    case "compare":
      return canonicalizeCompareExpr(expr);
  }
}

function canonicalizeProjectExpr(expr: JitProjectExpr): ExprRef {
  const value = canonicalizeExpr(expr.value);

  if (expr.width === 32) {
    return value;
  }

  if (value.kind === "const") {
    return exprConst(projectConst(value.value, expr.width));
  }

  if (value.kind === "project") {
    return canonicalizeExpr(exprProject(narrowerWidth(expr.width, value.width), value.value));
  }

  if (value.kind === "bits" && value.offset === 0) {
    return canonicalizeExpr(exprBits(value.value, 0, narrowerWidth(expr.width, value.width)));
  }

  return value === expr.value ? expr : exprProject(expr.width, value);
}

function canonicalizeBitsExpr(expr: JitBitsExpr): ExprRef {
  assertBitRange(expr.offset, expr.width, "bits");
  const value = canonicalizeExpr(expr.value);

  if (expr.offset === 0 && expr.width === 32) {
    return value;
  }

  if (expr.offset === 0) {
    return canonicalizeExpr(exprProject(expr.width, value));
  }

  if (value.kind === "const") {
    return exprConst(extractConstBits(value.value, expr.offset, expr.width));
  }

  if (value.kind === "bits" && expr.offset + expr.width <= value.width) {
    return canonicalizeExpr(exprBits(value.value, value.offset + expr.offset, expr.width));
  }

  if (value.kind === "project" && expr.offset >= value.width) {
    return exprConst(0);
  }

  return value === expr.value ? expr : exprBits(value, expr.offset, expr.width);
}

function canonicalizeInsertBitsExpr(expr: JitInsertBitsExpr): ExprRef {
  assertBitRange(expr.offset, expr.width, "insertBits");
  const base = canonicalizeExpr(expr.base);
  const value = canonicalizeExpr(expr.value);

  if (expr.offset === 0 && expr.width === 32) {
    return value;
  }

  if (base.kind === "const" && value.kind === "const") {
    return exprConst(insertConstBits(base.value, value.value, expr.offset, expr.width));
  }

  if (
    value.kind === "bits" &&
    value.offset === expr.offset &&
    value.width === expr.width &&
    exprsEqual(value.value, base)
  ) {
    return base;
  }

  if (
    expr.offset === 0 &&
    value.kind === "project" &&
    value.width === expr.width &&
    exprsEqual(value.value, base)
  ) {
    return base;
  }

  if (base.kind === "insertBits" && base.offset === expr.offset && base.width === expr.width) {
    return canonicalizeExpr(exprInsertBits(base.base, value, expr.offset, expr.width));
  }

  return base === expr.base && value === expr.value ? expr : exprInsertBits(base, value, expr.offset, expr.width);
}

function canonicalizeBinaryExpr(expr: JitBinaryExpr): ExprRef {
  const left = canonicalizeExpr(expr.left);
  const right = canonicalizeExpr(expr.right);

  return left === expr.left && right === expr.right ? expr : exprBinary(expr.op, left, right);
}

function canonicalizeUnaryExpr(expr: JitUnaryExpr): ExprRef {
  const value = canonicalizeExpr(expr.value);

  return value === expr.value ? expr : exprUnary(expr.op, value);
}

function canonicalizeSelectExpr(expr: JitSelectExpr): ExprRef {
  const condition = canonicalizeExpr(expr.condition);
  const whenTrue = canonicalizeExpr(expr.whenTrue);
  const whenFalse = canonicalizeExpr(expr.whenFalse);

  return condition === expr.condition && whenTrue === expr.whenTrue && whenFalse === expr.whenFalse
    ? expr
    : exprSelect(condition, whenTrue, whenFalse);
}

function canonicalizeTestBitExpr(expr: JitTestBitExpr): ExprRef {
  assertBitIndex(expr.bit, "testBit");
  const value = canonicalizeExpr(expr.value);

  if (value.kind === "const") {
    return exprConst(((value.value >>> 0) & (1 << expr.bit)) === 0 ? 0 : 1);
  }

  if (value.kind === "project" && expr.bit >= value.width) {
    return exprConst(0);
  }

  return value === expr.value ? expr : exprTestBit(value, expr.bit);
}

function canonicalizeCompareExpr(expr: JitCompareExpr): ExprRef {
  const left = canonicalizeExpr(expr.left);
  const right = canonicalizeExpr(expr.right);

  return left === expr.left && right === expr.right ? expr : exprCompare(expr.width, expr.op, left, right);
}

function projectConst(value: number, width: OperandWidth): number {
  return i32((value >>> 0) & (widthMask(width) >>> 0));
}

function extractConstBits(value: number, bitOffset: number, width: OperandWidth): number {
  return i32(((value >>> 0) >>> bitOffset) & (widthMask(width) >>> 0));
}

function insertConstBits(base: number, value: number, bitOffset: number, width: OperandWidth): number {
  const mask = bitRangeMask(bitOffset, width);
  const replacement = (((value >>> 0) & (widthMask(width) >>> 0)) << bitOffset) >>> 0;

  return i32(((base >>> 0) & (~mask >>> 0)) | replacement);
}

function narrowerWidth(left: OperandWidth, right: OperandWidth): OperandWidth {
  return left < right ? left : right;
}
