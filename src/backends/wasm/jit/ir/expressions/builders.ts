import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type {
  ExprRef,
  JitInputSource,
  ScalarBinaryOp,
  ScalarCompareOp,
  ScalarUnaryOp
} from "./types.js";

export function exprConst(value: number): ExprRef {
  return freezeExpr({ kind: "const", value: i32(value) });
}

export function exprInput(source: JitInputSource): ExprRef {
  return freezeExpr({ kind: "input", source: freezeInputSource(source) });
}

export function exprProject(width: OperandWidth, value: ExprRef): ExprRef {
  assertOperandWidth(width, "project width");

  return freezeExpr({ kind: "project", width, value });
}

export function exprBits(value: ExprRef, bitOffset: number, width: OperandWidth): ExprRef {
  assertBitRange(bitOffset, width, "bits");

  return freezeExpr({ kind: "bits", value, offset: bitOffset, width });
}

export function exprInsertBits(
  base: ExprRef,
  value: ExprRef,
  bitOffset: number,
  width: OperandWidth
): ExprRef {
  assertBitRange(bitOffset, width, "insertBits");

  return freezeExpr({ kind: "insertBits", base, value, offset: bitOffset, width });
}

export function exprBinary(op: ScalarBinaryOp, left: ExprRef, right: ExprRef): ExprRef {
  return freezeExpr({ kind: "binary", op, left, right });
}

export function exprUnary(op: ScalarUnaryOp, value: ExprRef): ExprRef {
  return freezeExpr({ kind: "unary", op, value });
}

export function exprSelect(condition: ExprRef, whenTrue: ExprRef, whenFalse: ExprRef): ExprRef {
  return freezeExpr({ kind: "select", condition, whenTrue, whenFalse });
}

export function exprCompare(width: OperandWidth, op: ScalarCompareOp, left: ExprRef, right: ExprRef): ExprRef {
  assertOperandWidth(width, "compare width");

  return freezeExpr({ kind: "compare", width, op, left, right });
}

export function assertBitRange(bitOffset: number, width: OperandWidth, context: string): void {
  if (
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    !isOperandWidth(width) ||
    bitOffset + width > 32
  ) {
    throw new Error(`${context} range must fit in 32 bits`);
  }
}

export function assertBitIndex(bit: number, context: string): void {
  if (!Number.isInteger(bit) || bit < 0 || bit >= 32) {
    throw new Error(`${context} bit must be in range 0..31`);
  }
}

export function checkedU32Mask(mask: number, context: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff_ffff) {
    throw new Error(`${context} must be a 32-bit unsigned mask`);
  }

  return mask >>> 0;
}

export function bitRangeMask(bitOffset: number, width: OperandWidth): number {
  assertBitRange(bitOffset, width, "bit range");

  if (width === 32) {
    return 0xffff_ffff;
  }

  return ((widthMask(width) << bitOffset) >>> 0);
}

export function freezeExpr<T extends ExprRef>(expr: T): T {
  return Object.freeze(expr);
}

function assertOperandWidth(width: OperandWidth, context: string): void {
  if (!isOperandWidth(width)) {
    throw new Error(`${context} must be 8, 16, or 32`);
  }
}

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}

function freezeInputSource(source: JitInputSource): JitInputSource {
  switch (source.kind) {
    case "reg":
      return Object.freeze({ kind: "reg", reg: source.reg });
    case "flag":
      return Object.freeze({ kind: "flag", flag: source.flag });
  }
}
