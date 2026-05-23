import type { OperandWidth, Reg32 } from "#x86/isa/types.js";
import type { FlagName } from "#x86/ir/model/flags.js";

export type ScalarBinaryOp =
  | "add"
  | "sub"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr_u";

export type ScalarUnaryOp =
  | "not"
  | "neg"
  | "extend8_s"
  | "extend16_s";

export type ScalarCompareOp =
  | "eq"
  | "ne"
  | "lt_u"
  | "le_u"
  | "gt_u"
  | "ge_u"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s";

export type JitInputSource =
  | Readonly<{ kind: "reg"; reg: Reg32 }>
  | Readonly<{ kind: "flag"; flag: FlagName }>;

export type JitConstExpr = Readonly<{ kind: "const"; value: number }>;
export type JitInputExpr = Readonly<{ kind: "input"; source: JitInputSource }>;
export type JitBinaryExpr = Readonly<{ kind: "binary"; op: ScalarBinaryOp; left: ExprRef; right: ExprRef }>;
export type JitUnaryExpr = Readonly<{ kind: "unary"; op: ScalarUnaryOp; value: ExprRef }>;
export type JitSelectExpr = Readonly<{
  kind: "select";
  condition: ExprRef;
  whenTrue: ExprRef;
  whenFalse: ExprRef;
}>;
export type JitProjectExpr = Readonly<{ kind: "project"; width: OperandWidth; value: ExprRef }>;
export type JitBitsExpr = Readonly<{ kind: "bits"; offset: number; width: OperandWidth; value: ExprRef }>;
export type JitInsertBitsExpr = Readonly<{
  kind: "insertBits";
  base: ExprRef;
  value: ExprRef;
  offset: number;
  width: OperandWidth;
}>;
export type JitTestBitExpr = Readonly<{ kind: "testBit"; bit: number; value: ExprRef }>;
export type JitCompareExpr = Readonly<{ kind: "compare"; op: ScalarCompareOp; left: ExprRef; right: ExprRef }>;

export type JitScalarExpr =
  | JitConstExpr
  | JitInputExpr
  | JitBinaryExpr
  | JitUnaryExpr
  | JitSelectExpr
  | JitProjectExpr
  | JitBitsExpr
  | JitInsertBitsExpr
  | JitTestBitExpr
  | JitCompareExpr;

export type ExprRef = JitScalarExpr;

export type ExprUse =
  | Readonly<{ kind: "exact" }>
  | Readonly<{ kind: "full32" }>
  | Readonly<{ kind: "bits"; mask: number }>;
