import { CONDITIONS, type FlagBoolExpr } from "#x86/ir/model/conditions.js";
import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import {
  flagProducerConditionKind,
  requiredFlagProducerConditionInput
} from "#x86/ir/model/flag-conditions.js";
import type { ConditionCode } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";
import type { WasmIrEmitHelpers } from "./emit.js";

type EmitAluFlagsValue = (mask: number) => void;

export function emitFlagsCondition(
  body: WasmFunctionBodyEncoder,
  aluFlags: WasmIrAluFlagsStorage,
  cc: ConditionCode
): void {
  emitFlagsConditionFromAluFlagsValue(body, cc, () => {
    aluFlags.emitLoad();
  });
}

export function emitFlagsConditionFromAluFlagsValue(
  body: WasmFunctionBodyEncoder,
  cc: ConditionCode,
  emitAluFlagsValue: EmitAluFlagsValue
): void {
  emitFlagsConditionExpression(body, cc, emitAluFlagsValue);
}

export function emitFlagProducerCondition(
  body: WasmFunctionBodyEncoder,
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  switch (flagProducerConditionKind(condition)) {
    case "eq":
      emitInputCompare(condition, helpers);
      body.i32Xor().i32Eqz();
      return;
    case "ne":
      emitInputCompare(condition, helpers);
      body.i32Xor().i32Eqz().i32Eqz();
      return;
    case "uLt":
      emitInputCompare(condition, helpers);
      body.i32LtU();
      return;
    case "uGe":
      emitInputCompare(condition, helpers);
      body.i32LtU().i32Eqz();
      return;
    case "sLt":
      emitSignedInputCompare(body, condition, helpers);
      body.i32LtU();
      return;
    case "sGe":
      emitSignedInputCompare(body, condition, helpers);
      body.i32LtU().i32Eqz();
      return;
    case "sLe":
      emitSignedInputCompare(body, condition, helpers);
      body.i32GtU().i32Eqz();
      return;
    case "sGt":
      emitSignedInputCompare(body, condition, helpers);
      body.i32GtU();
      return;
    case "zero":
      emitResultInput(condition, helpers);
      body.i32Eqz();
      return;
    case "nonZero":
      emitResultInput(condition, helpers);
      body.i32Eqz().i32Eqz();
      return;
    case "sign":
      emitResultSign(body, condition, helpers);
      body.i32Eqz().i32Eqz();
      return;
    case "notSign":
      emitResultSign(body, condition, helpers);
      body.i32Eqz();
      return;
    case "parity8":
      emitResultParity(body, condition, helpers);
      return;
    case "notParity8":
      emitResultParity(body, condition, helpers);
      body.i32Eqz();
      return;
    case "constTrue":
      body.i32Const(1);
      return;
    case "constFalse":
      body.i32Const(0);
      return;
    case "zeroOrSign":
      emitResultInput(condition, helpers);
      body.i32Eqz();
      emitResultSign(body, condition, helpers);
      body.i32Eqz().i32Eqz();
      body.i32Or();
      return;
    case "nonZeroAndNotSign":
      emitResultInput(condition, helpers);
      body.i32Eqz().i32Eqz();
      emitResultSign(body, condition, helpers);
      body.i32Eqz();
      body.i32And();
      return;
    case undefined:
      throw new Error(`unsupported flag producer condition: ${condition.producer}/${condition.cc}`);
  }
}

function emitFlagsConditionExpression(
  body: WasmFunctionBodyEncoder,
  cc: ConditionCode,
  emitAluFlagsValue: EmitAluFlagsValue
): void {
  const condition = CONDITIONS[cc];

  assertAluFlagsCondition(cc);
  emitFlagBoolExpr(body, emitAluFlagsValue, condition.expr);
}

function emitFlagBoolExpr(
  body: WasmFunctionBodyEncoder,
  emitAluFlagsValue: EmitAluFlagsValue,
  expr: FlagBoolExpr
): void {
  switch (expr.kind) {
    case "flag": {
      const mask = x86ArithmeticFlagMask[expr.flag];

      emitAluFlagsValue(mask);
      body.i32Const(mask).i32And().i32Eqz().i32Eqz();
      return;
    }
    case "not":
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.value);
      body.i32Eqz();
      return;
    case "and":
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.a);
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.b);
      body.i32And();
      return;
    case "or":
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.a);
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.b);
      body.i32Or();
      return;
    case "xor":
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.a);
      emitFlagBoolExpr(body, emitAluFlagsValue, expr.b);
      body.i32Xor();
      return;
  }
}

function assertAluFlagsCondition(cc: ConditionCode): void {
  const condition = CONDITIONS[cc];

  for (const flag of condition.reads) {
    if (!Object.hasOwn(x86ArithmeticFlagMask, flag)) {
      throw new Error(`flags.condition ${cc} reads non-ALU flag ${flag}`);
    }
  }
}

function emitInputCompare(
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  emitMaskedConditionInput(condition, helpers, "left");
  emitMaskedConditionInput(condition, helpers, "right");
}

function emitSignedInputCompare(
  body: WasmFunctionBodyEncoder,
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  emitSignedCompareInput(body, helpers, conditionWidth(condition), requiredFlagProducerConditionInput(condition, "left"));
  emitSignedCompareInput(body, helpers, conditionWidth(condition), requiredFlagProducerConditionInput(condition, "right"));
}

function emitSignedCompareInput(
  body: WasmFunctionBodyEncoder,
  helpers: WasmIrEmitHelpers,
  width: OperandWidth,
  value: IrValueExpr
): void {
  helpers.emitMaskedValue(value, width);
  body.i32Const(signMask(width)).i32Xor();
}

function emitResultInput(
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  helpers.emitMaskedValue(requiredFlagProducerConditionInput(condition, "result"), conditionWidth(condition));
}

function emitResultSign(
  body: WasmFunctionBodyEncoder,
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  emitResultInput(condition, helpers);
  body.i32Const(signMask(conditionWidth(condition))).i32And();
}

function emitResultParity(
  body: WasmFunctionBodyEncoder,
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers
): void {
  emitResultInput(condition, helpers);
  body.i32Const(0xff).i32And().i32Popcnt().i32Const(1).i32And().i32Eqz();
}

function emitMaskedConditionInput(
  condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>,
  helpers: WasmIrEmitHelpers,
  inputName: string
): void {
  helpers.emitMaskedValue(requiredFlagProducerConditionInput(condition, inputName), conditionWidth(condition));
}

function conditionWidth(condition: Extract<IrValueExpr, { kind: "flagProducer.condition" }>): OperandWidth {
  return condition.width ?? 32;
}

function signMask(width: OperandWidth): number {
  return width === 32 ? i32(0x8000_0000) : width === 16 ? 0x8000 : 0x80;
}
