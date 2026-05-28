import {
  emitMaskValueToWidth,
  type ValueWidth
} from "#wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { widthMask } from "#x86/types.js";
import { i32 } from "#x86/numeric.js";
import {
  bitRangeMask,
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type {
  ExprRef,
  ExprInputSource,
  ScalarBinaryOp,
  ScalarCompareOp,
  ScalarUnaryOp
} from "#ir/expr/types.js";

export type EmittedValueWidth = ValueWidth;

export type EmittedExpr = Readonly<{
  valueWidth: EmittedValueWidth;
}>;

export type ExprInputEmitter = Readonly<{
  emitInput(source: ExprInputSource): EmittedExpr;
}>;

export type ExprEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  inputs: ExprInputEmitter;
}>;

export type ExpressionEmitter = Readonly<{
  emitExpr(expr: ExprRef): EmittedExpr;
}>;

export function createExpressionEmitter(context: ExprEmitContext): ExpressionEmitter {
  return {
    emitExpr: (expr) => emitExpr(context, expr)
  };
}

export function emitExpr(context: ExprEmitContext, expr: ExprRef): EmittedExpr {
  return emitExprDirect(context, canonicalizeExpr(expr));
}

function emitExprDirect(context: ExprEmitContext, expr: ExprRef): EmittedExpr {
  switch (expr.kind) {
    case "const":
      return emitConstExpr(context, expr.value);
    case "input":
      return emitInputExpr(context, expr.source);
    case "project":
      return emitProjectExpr(context, expr.value, expr.width);
    case "bits":
      return emitBitsExpr(context, expr.value, expr.offset, expr.width);
    case "insertBits":
      return emitInsertBitsExpr(context, expr);
    case "unary":
      return emitUnaryExpr(context, expr.op, expr.value);
    case "binary":
      return emitBinaryExpr(context, expr.op, expr.left, expr.right);
    case "select":
      return emitSelectExpr(context, expr);
    case "compare":
      return emitCompareExpr(context, expr);
  }
}

function emitConstExpr(context: ExprEmitContext, value: number): EmittedExpr {
  const masked = value >>> 0;

  context.body.i32Const(i32(masked));
  return {
    valueWidth: { logicalWidth: 32, cleanWidth: 32, constValue: masked }
  };
}

function emitInputExpr(context: ExprEmitContext, source: ExprInputSource): EmittedExpr {
  return context.inputs.emitInput(source);
}

function emitProjectExpr(
  context: ExprEmitContext,
  value: ExprRef,
  width: 8 | 16 | 32
): EmittedExpr {
  const child = emitExpr(context, value);
  const valueWidth = emitMaskValueToWidth(context.body, width, child.valueWidth);

  return {
    valueWidth
  };
}

function emitBitsExpr(
  context: ExprEmitContext,
  value: ExprRef,
  offset: number,
  width: 8 | 16 | 32
): EmittedExpr {
  const child = emitExpr(context, value);

  if (offset !== 0) {
    context.body.i32Const(offset).i32ShrU();
  }

  const shiftedWidth = offset === 0 ? child.valueWidth : { logicalWidth: 32, cleanWidth: 32 } satisfies ValueWidth;
  const valueWidth = width !== 32
    ? emitMaskValueToWidth(context.body, width, shiftedWidth)
    : shiftedWidth;

  return {
    valueWidth
  };
}

function emitInsertBitsExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "insertBits" }>
): EmittedExpr {
  if (expr.offset === 0 && expr.width === 32) {
    return emitExpr(context, expr.value);
  }

  const insertedMask = bitRangeMask(expr.offset, expr.width);

  emitExpr(context, expr.base);
  context.body.i32Const(i32(~insertedMask)).i32And();
  emitExpr(context, expr.value);

  if (expr.width !== 32) {
    context.body.i32Const(widthMask(expr.width)).i32And();
  }

  if (expr.offset !== 0) {
    context.body.i32Const(expr.offset).i32Shl();
  }

  context.body.i32Or();
  return {
    valueWidth: { logicalWidth: 32, cleanWidth: 32 }
  };
}

function emitUnaryExpr(
  context: ExprEmitContext,
  op: ScalarUnaryOp,
  value: ExprRef
): EmittedExpr {
  switch (op) {
    case "extend8_s":
      emitExpr(context, value);
      context.body.i32Extend8S();
      return emittedExpr({ logicalWidth: 32, cleanWidth: 32 });
    case "extend16_s":
      emitExpr(context, value);
      context.body.i32Extend16S();
      return emittedExpr({ logicalWidth: 32, cleanWidth: 32 });
    case "popcnt":
      emitExpr(context, value);
      context.body.i32Popcnt();
      return emittedExpr({ logicalWidth: 8, cleanWidth: 8 });
  }
}

function emitBinaryExpr(
  context: ExprEmitContext,
  op: ScalarBinaryOp,
  left: ExprRef,
  right: ExprRef
): EmittedExpr {
  emitExpr(context, left);
  emitExpr(context, right);
  emitScalarBinaryInstruction(context.body, op);
  return emittedExpr();
}

function emitSelectExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "select" }>
): EmittedExpr {
  emitExpr(context, expr.whenTrue);
  emitExpr(context, expr.whenFalse);
  emitExpr(context, expr.condition);
  context.body.select();
  return emittedExpr();
}

function emitCompareExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "compare" }>
): EmittedExpr {
  const operandPreparation = compareOperandPreparation(expr.op);

  emitCompareOperand(context, expr.left, expr.width, operandPreparation);
  emitCompareOperand(context, expr.right, expr.width, operandPreparation);
  emitScalarCompareInstruction(context.body, expr.op);
  return emittedExpr({ logicalWidth: 8, cleanWidth: 8 });
}

type CompareOperandPreparation = "signExtend" | "zeroClean";

function emitCompareOperand(
  context: ExprEmitContext,
  value: ExprRef,
  width: 8 | 16 | 32,
  preparation: CompareOperandPreparation
): void {
  const emitted = emitExpr(context, value);

  switch (preparation) {
    case "signExtend":
      emitCompareOperandSignExtension(context, width);
      return;
    case "zeroClean":
      emitCompareOperandCleanup(context, emitted.valueWidth, width);
      return;
  }
}

function emitCompareOperandSignExtension(context: ExprEmitContext, width: 8 | 16 | 32): void {
  switch (width) {
    case 8:
      context.body.i32Extend8S();
      return;
    case 16:
      context.body.i32Extend16S();
      return;
    case 32:
      return;
  }
}

function emitCompareOperandCleanup(context: ExprEmitContext, valueWidth: ValueWidth, width: 8 | 16 | 32): void {
  if (width === 32) {
    return;
  }

  emitMaskValueToWidth(context.body, width, valueWidth);
}

function compareOperandPreparation(op: ScalarCompareOp): CompareOperandPreparation {
  switch (op) {
    case "lt_s":
    case "le_s":
    case "gt_s":
    case "ge_s":
      return "signExtend";
    case "eq":
    case "ne":
    case "lt_u":
    case "le_u":
    case "gt_u":
    case "ge_u":
      return "zeroClean";
  }
}

function emitScalarBinaryInstruction(body: WasmFunctionBodyEncoder, op: ScalarBinaryOp): void {
  switch (op) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "and":
      body.i32And();
      return;
    case "or":
      body.i32Or();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "shl":
      body.i32Shl();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

function emitScalarCompareInstruction(body: WasmFunctionBodyEncoder, op: ScalarCompareOp): void {
  switch (op) {
    case "eq":
      body.i32Eq();
      return;
    case "ne":
      body.i32Ne();
      return;
    case "lt_u":
      body.i32LtU();
      return;
    case "le_u":
      body.i32LeU();
      return;
    case "gt_u":
      body.i32GtU();
      return;
    case "ge_u":
      body.i32GeU();
      return;
    case "lt_s":
      body.i32LtS();
      return;
    case "le_s":
      body.i32LeS();
      return;
    case "gt_s":
      body.i32GtS();
      return;
    case "ge_s":
      body.i32GeS();
      return;
  }
}

function emittedExpr(
  valueWidth: ValueWidth = { logicalWidth: 32, cleanWidth: 32 }
): EmittedExpr {
  return {
    valueWidth
  };
}
