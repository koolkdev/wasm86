import type { OperandWidth, Reg32 } from "#x86/types.js";
import type { FlagName } from "#ir/model/flags.js";

// Binary expressions are generic 32-bit scalar operations. x86 8/16-bit
// semantics must be represented with explicit project/bits nodes around
// operands and results.
export type ScalarBinaryOp =
  | "add"
  | "sub"
  | "and"
  | "or"
  | "xor"
  | "shl"
  | "shr_u";

export type ScalarUnaryOp =
  | "extend8_s"
  | "extend16_s"
  | "popcnt";

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

export type ExprInputSource =
  | Readonly<{ kind: "reg"; reg: Reg32 }>
  | Readonly<{ kind: "flag"; flag: FlagName }>
  | Readonly<{ kind: "def"; id: number }>;

export type ConstExpr = Readonly<{ kind: "const"; value: number }>;
export type InputExpr = Readonly<{ kind: "input"; source: ExprInputSource }>;
export type BinaryExpr = Readonly<{ kind: "binary"; op: ScalarBinaryOp; left: ExprRef; right: ExprRef }>;
export type UnaryExpr = Readonly<{ kind: "unary"; op: ScalarUnaryOp; value: ExprRef }>;
export type SelectExpr = Readonly<{
  kind: "select";
  condition: ExprRef;
  whenTrue: ExprRef;
  whenFalse: ExprRef;
}>;
export type ProjectExpr = Readonly<{ kind: "project"; width: OperandWidth; value: ExprRef }>;
export type BitsExpr = Readonly<{ kind: "bits"; offset: number; width: OperandWidth; value: ExprRef }>;
export type InsertBitsExpr = Readonly<{
  kind: "insertBits";
  base: ExprRef;
  value: ExprRef;
  offset: number;
  width: OperandWidth;
}>;
export type CompareExpr = Readonly<{
  kind: "compare";
  width: OperandWidth;
  op: ScalarCompareOp;
  left: ExprRef;
  right: ExprRef;
}>;

export type ExprRef =
  | ConstExpr
  | InputExpr
  | BinaryExpr
  | UnaryExpr
  | SelectExpr
  | ProjectExpr
  | BitsExpr
  | InsertBitsExpr
  | CompareExpr;

export type ExprUse =
  | Readonly<{ kind: "exact" }>
  | Readonly<{ kind: "full32" }>
  | Readonly<{ kind: "bits"; mask: number }>;
