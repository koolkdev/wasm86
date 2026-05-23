import {
  emitMaskValueToWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { widthMask } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import {
  bitRangeMask,
  checkedU32Mask
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import {
  bitsUse,
  childUseForExpr
} from "#backends/wasm/jit/ir/expressions/uses.js";
import type {
  ExprRef,
  ExprUse,
  JitInputSource,
  ScalarBinaryOp,
  ScalarCompareOp,
  ScalarUnaryOp
} from "#backends/wasm/jit/ir/expressions/types.js";

export type EmittedValueWidth = ValueWidth;

export type EmittedExpr = Readonly<{
  valueWidth: EmittedValueWidth;
}>;

export type ExprInputEmitter = Readonly<{
  emitInput(source: JitInputSource, use: ExprUse): EmittedExpr;
}>;

export type ExprEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  inputs: ExprInputEmitter;
}>;

export type ExpressionEmitter = Readonly<{
  emitExpr(expr: ExprRef, use: ExprUse): EmittedExpr;
}>;

export function createExpressionEmitter(context: ExprEmitContext): ExpressionEmitter {
  return {
    emitExpr: (expr, use) => emitExpr(context, expr, use)
  };
}

export function emitExpr(context: ExprEmitContext, expr: ExprRef, use: ExprUse): EmittedExpr {
  return emitExprDirect(context, canonicalizeExpr(expr), canonicalizeUse(use));
}

function emitExprDirect(context: ExprEmitContext, expr: ExprRef, use: ExprUse): EmittedExpr {
  if (use.kind === "bits" && use.mask === 0) {
    return emitZeroExpr(context);
  }

  switch (expr.kind) {
    case "const":
      return emitConstExpr(context, expr.value, use);
    case "input":
      return emitInputExpr(context, expr.source, use);
    case "project":
      return emitProjectExpr(context, expr.value, expr.width, use);
    case "bits":
      return emitBitsExpr(context, expr.value, expr.offset, expr.width, use);
    case "insertBits":
      return emitInsertBitsExpr(context, expr, use);
    case "unary":
      return emitUnaryExpr(context, expr.op, expr.value, use);
    case "binary":
      return emitBinaryExpr(context, expr.op, expr.left, expr.right, use);
    case "select":
      return emitSelectExpr(context, expr, use);
    case "testBit":
      return emitTestBitExpr(context, expr.value, expr.bit, use);
    case "compare":
      return emitCompareExpr(context, expr, use);
  }
}

function emitConstExpr(context: ExprEmitContext, value: number, use: ExprUse): EmittedExpr {
  const masked = use.kind === "bits" ? (value & use.mask) >>> 0 : value >>> 0;

  context.body.i32Const(i32(masked));
  return {
    valueWidth: { logicalWidth: 32, cleanWidth: 32, constValue: masked }
  };
}

function emitInputExpr(context: ExprEmitContext, source: JitInputSource, use: ExprUse): EmittedExpr {
  return context.inputs.emitInput(source, use);
}

function emitProjectExpr(
  context: ExprEmitContext,
  value: ExprRef,
  width: 8 | 16 | 32,
  use: ExprUse
): EmittedExpr {
  const requestedMask = useMask(use);
  const projectMask = widthMask(width) >>> 0;
  const demandedValueMask = (requestedMask & projectMask) >>> 0;

  if (demandedValueMask === 0) {
    return emitZeroExpr(context);
  }

  const child = emitExpr(context, value, childUseForExpr({ kind: "project", width, value }, 0, use));
  const needsCleanProjection = use.kind !== "bits" || (requestedMask & ~projectMask) !== 0;
  const valueWidth = needsCleanProjection
    ? emitMaskValueToWidth(context.body, width, child.valueWidth)
    : child.valueWidth;

  return {
    valueWidth
  };
}

function emitBitsExpr(
  context: ExprEmitContext,
  value: ExprRef,
  offset: number,
  width: 8 | 16 | 32,
  use: ExprUse
): EmittedExpr {
  const requestedMask = useMask(use);
  const resultMask = widthMask(width) >>> 0;
  const demandedValueMask = (requestedMask & resultMask) >>> 0;

  if (demandedValueMask === 0) {
    return emitZeroExpr(context);
  }

  const child = emitExpr(context, value, childUseForExpr({ kind: "bits", offset, width, value }, 0, use));

  if (offset !== 0) {
    context.body.i32Const(offset).i32ShrU();
  }

  const needsCleanExtraction = use.kind !== "bits" || (requestedMask & ~resultMask) !== 0;
  const shiftedWidth = offset === 0 ? child.valueWidth : { logicalWidth: 32, cleanWidth: 32 } satisfies ValueWidth;
  const valueWidth = needsCleanExtraction && width !== 32
    ? emitMaskValueToWidth(context.body, width, shiftedWidth)
    : shiftedWidth;

  return {
    valueWidth
  };
}

function emitInsertBitsExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "insertBits" }>,
  use: ExprUse
): EmittedExpr {
  if (use.kind === "bits") {
    return emitInsertBitsForPartialUse(context, expr, use);
  }

  if (expr.offset === 0 && expr.width === 32) {
    return emitExpr(context, expr.value, use);
  }

  const insertedMask = bitRangeMask(expr.offset, expr.width);

  emitExpr(context, expr.base, childUseForExpr(expr, 0, use));
  context.body.i32Const(i32(~insertedMask)).i32And();
  emitExpr(context, expr.value, childUseForExpr(expr, 1, use));

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

function emitInsertBitsForPartialUse(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "insertBits" }>,
  use: Extract<ExprUse, { kind: "bits" }>
): EmittedExpr {
  const parentMask = checkedU32Mask(use.mask, "expression use mask");
  const insertedMask = bitRangeMask(expr.offset, expr.width);
  const baseMask = (parentMask & ~insertedMask) >>> 0;
  const insertedDemandMask = (parentMask & insertedMask) >>> 0;

  if (baseMask === 0 && insertedDemandMask === 0) {
    return emitZeroExpr(context);
  }

  if (insertedDemandMask === 0) {
    return emitExpr(context, expr.base, use);
  }

  if (baseMask === 0) {
    const valueMask = (insertedDemandMask >>> expr.offset) >>> 0;
    const value = emitExpr(context, expr.value, bitsUse(valueMask));

    if (expr.offset !== 0) {
      context.body.i32Const(expr.offset).i32Shl();
    }

    return {
      valueWidth: expr.offset === 0 ? value.valueWidth : { logicalWidth: 32, cleanWidth: 32 }
    };
  }

  emitExpr(context, expr.base, bitsUse(baseMask));
  context.body.i32Const(i32(baseMask)).i32And();

  const valueMask = (insertedDemandMask >>> expr.offset) >>> 0;
  emitExpr(context, expr.value, bitsUse(valueMask));
  context.body.i32Const(i32(valueMask)).i32And();

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
  value: ExprRef,
  use: ExprUse
): EmittedExpr {
  const expr = { kind: "unary", op, value } as const;

  switch (op) {
    case "extend8_s":
      emitExpr(context, value, childUseForExpr(expr, 0, use));
      context.body.i32Extend8S();
      return emittedExpr({ logicalWidth: 32, cleanWidth: 32 });
    case "extend16_s":
      emitExpr(context, value, childUseForExpr(expr, 0, use));
      context.body.i32Extend16S();
      return emittedExpr({ logicalWidth: 32, cleanWidth: 32 });
  }
}

function emitBinaryExpr(
  context: ExprEmitContext,
  op: ScalarBinaryOp,
  left: ExprRef,
  right: ExprRef,
  use: ExprUse
): EmittedExpr {
  const expr = { kind: "binary", op, left, right } as const;

  emitExpr(context, left, childUseForExpr(expr, 0, use));
  emitExpr(context, right, childUseForExpr(expr, 1, use));
  emitScalarBinaryInstruction(context.body, op);
  return emittedExpr();
}

function emitSelectExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "select" }>,
  use: ExprUse
): EmittedExpr {
  emitExpr(context, expr.whenTrue, childUseForExpr(expr, 1, use));
  emitExpr(context, expr.whenFalse, childUseForExpr(expr, 2, use));
  emitExpr(context, expr.condition, childUseForExpr(expr, 0, use));
  context.body.select();
  return emittedExpr();
}

function emitTestBitExpr(
  context: ExprEmitContext,
  value: ExprRef,
  bit: number,
  use: ExprUse
): EmittedExpr {
  emitExpr(context, value, childUseForExpr({ kind: "testBit", bit, value }, 0, use));

  if (bit !== 0) {
    context.body.i32Const(bit).i32ShrU();
  }

  context.body.i32Const(1).i32And();
  return emittedExpr({ logicalWidth: 8, cleanWidth: 8 });
}

function emitCompareExpr(
  context: ExprEmitContext,
  expr: Extract<ExprRef, { kind: "compare" }>,
  use: ExprUse
): EmittedExpr {
  if ((useMask(use) & 1) === 0) {
    return emitZeroExpr(context);
  }

  const operandPreparation = compareOperandPreparation(expr.op);

  emitCompareOperand(context, expr.left, childUseForExpr(expr, 0, use), expr.width, operandPreparation);
  emitCompareOperand(context, expr.right, childUseForExpr(expr, 1, use), expr.width, operandPreparation);
  emitScalarCompareInstruction(context.body, expr.op);
  return emittedExpr({ logicalWidth: 8, cleanWidth: 8 });
}

type CompareOperandPreparation = "signExtend" | "zeroClean";

function emitCompareOperand(
  context: ExprEmitContext,
  value: ExprRef,
  use: ExprUse,
  width: 8 | 16 | 32,
  preparation: CompareOperandPreparation
): void {
  const emitted = emitExpr(context, value, use);

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

function emitZeroExpr(context: ExprEmitContext): EmittedExpr {
  context.body.i32Const(0);
  return {
    valueWidth: { logicalWidth: 8, cleanWidth: 8, constValue: 0 }
  };
}

function canonicalizeUse(use: ExprUse): ExprUse {
  return use.kind === "bits" ? bitsUse(use.mask) : use;
}

function useMask(use: ExprUse): number {
  switch (use.kind) {
    case "exact":
    case "full32":
      return 0xffff_ffff;
    case "bits":
      return checkedU32Mask(use.mask, "expression use mask");
  }
}
