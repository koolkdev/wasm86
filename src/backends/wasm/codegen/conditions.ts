import { CONDITIONS, type FlagBoolExpr } from "#x86/ir/model/conditions.js";
import { flagProducerConditionKind } from "#x86/ir/model/flag-conditions.js";
import type { FlagProducerInputs } from "#x86/ir/model/flags.js";
import { requiredFlagProducerInput } from "#x86/ir/model/flags.js";
import type { ConditionCode, FlagProducerName } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";
import { i32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";
import type { WasmFlagValueEmitHelpers } from "./flags.js";

type EmitAluFlagsValue = (mask: number) => void;
type EmitMaskedConditionInput = (inputName: string, width: OperandWidth) => void;

export type FlagProducerConditionInputDescriptor<T> = Readonly<{
  cc: ConditionCode;
  producer: FlagProducerName;
  width?: OperandWidth | undefined;
  inputs: FlagProducerInputs<T>;
}>;

type FlagProducerConditionMetadata = Readonly<{
  cc: ConditionCode;
  producer: FlagProducerName;
  width?: OperandWidth | undefined;
}>;

type FlagProducerConditionWidth = Pick<FlagProducerConditionMetadata, "width">;

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

export function emitFlagProducerConditionFromInputs<T>(
  body: WasmFunctionBodyEncoder,
  condition: FlagProducerConditionInputDescriptor<T>,
  helpers: WasmFlagValueEmitHelpers<T>
): void {
  emitFlagProducerConditionWithInputs(
    body,
    condition,
    (inputName, width) => helpers.emitMaskedValue(requiredFlagProducerInput(condition.producer, condition.inputs, inputName), width)
  );
}

function emitFlagProducerConditionWithInputs(
  body: WasmFunctionBodyEncoder,
  condition: FlagProducerConditionMetadata,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  switch (flagProducerConditionKindDescriptor(condition)) {
    case "eq":
      emitInputCompare(condition, emitMaskedInput);
      body.i32Xor().i32Eqz();
      return;
    case "ne":
      emitInputCompare(condition, emitMaskedInput);
      body.i32Xor().i32Eqz().i32Eqz();
      return;
    case "uLt":
      emitInputCompare(condition, emitMaskedInput);
      body.i32LtU();
      return;
    case "uGe":
      emitInputCompare(condition, emitMaskedInput);
      body.i32LtU().i32Eqz();
      return;
    case "sLt":
      emitSignedInputCompare(body, condition, emitMaskedInput);
      body.i32LtU();
      return;
    case "sGe":
      emitSignedInputCompare(body, condition, emitMaskedInput);
      body.i32LtU().i32Eqz();
      return;
    case "sLe":
      emitSignedInputCompare(body, condition, emitMaskedInput);
      body.i32GtU().i32Eqz();
      return;
    case "sGt":
      emitSignedInputCompare(body, condition, emitMaskedInput);
      body.i32GtU();
      return;
    case "zero":
      emitResultInput(condition, emitMaskedInput);
      body.i32Eqz();
      return;
    case "nonZero":
      emitResultInput(condition, emitMaskedInput);
      body.i32Eqz().i32Eqz();
      return;
    case "sign":
      emitResultSign(body, condition, emitMaskedInput);
      body.i32Eqz().i32Eqz();
      return;
    case "notSign":
      emitResultSign(body, condition, emitMaskedInput);
      body.i32Eqz();
      return;
    case "parity8":
      emitResultParity(body, condition, emitMaskedInput);
      return;
    case "notParity8":
      emitResultParity(body, condition, emitMaskedInput);
      body.i32Eqz();
      return;
    case "constTrue":
      body.i32Const(1);
      return;
    case "constFalse":
      body.i32Const(0);
      return;
    case "zeroOrSign":
      emitResultInput(condition, emitMaskedInput);
      body.i32Eqz();
      emitResultSign(body, condition, emitMaskedInput);
      body.i32Eqz().i32Eqz();
      body.i32Or();
      return;
    case "nonZeroAndNotSign":
      emitResultInput(condition, emitMaskedInput);
      body.i32Eqz().i32Eqz();
      emitResultSign(body, condition, emitMaskedInput);
      body.i32Eqz();
      body.i32And();
      return;
    case undefined:
      throw new Error(`unsupported flag producer condition: ${condition.producer}/${condition.cc}`);
  }
}

function flagProducerConditionKindDescriptor(
  condition: FlagProducerConditionMetadata
) {
  const descriptor = {
    cc: condition.cc,
    producer: condition.producer,
    ...(condition.width === undefined ? {} : { width: condition.width })
  };

  return flagProducerConditionKind(descriptor);
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
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  emitMaskedConditionInput(condition, emitMaskedInput, "left");
  emitMaskedConditionInput(condition, emitMaskedInput, "right");
}

function emitSignedInputCompare(
  body: WasmFunctionBodyEncoder,
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  emitSignedCompareInput(body, emitMaskedInput, conditionWidth(condition), "left");
  emitSignedCompareInput(body, emitMaskedInput, conditionWidth(condition), "right");
}

function emitSignedCompareInput(
  body: WasmFunctionBodyEncoder,
  emitMaskedInput: EmitMaskedConditionInput,
  width: OperandWidth,
  inputName: string
): void {
  emitMaskedInput(inputName, width);
  body.i32Const(signMask(width)).i32Xor();
}

function emitResultInput(
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  emitMaskedInput("result", conditionWidth(condition));
}

function emitResultSign(
  body: WasmFunctionBodyEncoder,
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  emitResultInput(condition, emitMaskedInput);
  body.i32Const(signMask(conditionWidth(condition))).i32And();
}

function emitResultParity(
  body: WasmFunctionBodyEncoder,
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput
): void {
  emitResultInput(condition, emitMaskedInput);
  body.i32Const(0xff).i32And().i32Popcnt().i32Const(1).i32And().i32Eqz();
}

function emitMaskedConditionInput(
  condition: FlagProducerConditionWidth,
  emitMaskedInput: EmitMaskedConditionInput,
  inputName: string
): void {
  emitMaskedInput(inputName, conditionWidth(condition));
}

function conditionWidth(condition: FlagProducerConditionWidth): OperandWidth {
  return condition.width ?? 32;
}

function signMask(width: OperandWidth): number {
  return width === 32 ? i32(0x8000_0000) : width === 16 ? 0x8000 : 0x80;
}
