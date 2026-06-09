import { CONDITIONS, type FlagBoolExpr } from "#ir/model/conditions.js";
import type { ConditionCode } from "#ir/model/types.js";
import { x86ArithmeticFlagMask } from "#x86/flags.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";

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
