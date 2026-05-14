import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { Reg32 } from "#x86/isa/types.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { IrExprBlock, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import {
  planJitCodegen
} from "#backends/wasm/jit/codegen/plan/plan.js";
import {
  branchValuePathScope,
  rootValuePathScope
} from "#backends/wasm/jit/codegen/plan/control-paths.js";
import { planJitExpressionValueCacheForInstructions } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  JitCodegenPlan,
  JitExitMaterializationStore,
  JitExitPoint,
  JitExitStateSnapshot,
  JitInstructionState,
  JitMaterializationNeed,
  JitObservationPayload,
  JitObservationValue
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitProducedValue,
  type JitProducedValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { optimizeJitIrBlock } from "#backends/wasm/jit/optimization/optimize.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { onlyExit, startAddress } from "../../../optimization/tests/helpers.js";

export {
  deepStrictEqual,
  strictEqual,
  throws,
  test,
  ok,
  decodeBytes,
  IR_ALU_FLAG_MASK,
  FLAG_PRODUCERS,
  ExitReason,
  buildJitIrBlock,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  branchValuePathScope,
  rootValuePathScope,
  planJitExpressionValueCacheForInstructions,
  buildJitInstructionValueTimeline,
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitProducedValue,
  optimizeJitIrBlock,
  createJitValueState,
  onlyExit,
  startAddress
};
export type {
  Reg32,
  IrExprBlock,
  IrValueExpr,
  JitOperandBinding,
  JitCodegenPlan,
  JitExitMaterializationStore,
  JitExitPoint,
  JitExitStateSnapshot,
  JitInstructionState,
  JitMaterializationNeed,
  JitObservationPayload,
  JitObservationValue,
  JitProducedValue,
  JitValue,
  JitIrBlock
};

export function planValueCacheForTest(input: Readonly<{
  operands?: readonly JitOperandBinding[];
  expressionBlock: IrExprBlock;
  producedValuesByVarId?: ReadonlyMap<number, JitProducedValue>;
  materializationJitValueUsesByExpressionIndex?: ReadonlyMap<number, readonly JitValue[]>;
}>) {
  const operands = input.operands ?? [];

  return planJitExpressionValueCacheForInstructions([{
    operands,
    expressionBlock: input.expressionBlock,
    valueTimeline: buildJitInstructionValueTimeline({
      operands,
      expressionBlock: input.expressionBlock,
      entryValueState: createJitValueState().snapshot(),
      ...(input.producedValuesByVarId === undefined
        ? {}
        : { producedValuesByVarId: input.producedValuesByVarId })
    }),
    ...(input.materializationJitValueUsesByExpressionIndex === undefined
      ? {}
      : { materializationJitValueUsesByExpressionIndex: input.materializationJitValueUsesByExpressionIndex })
  }]);
}

export function registerStore(reg: Reg32, value: JitValue = jitInputReg32Value(reg)): JitExitMaterializationStore {
  return {
    target: { kind: "reg32", reg },
    value
  };
}

export function flagStore(value: JitValue): JitExitMaterializationStore {
  return {
    target: { kind: "aluFlags" },
    value
  };
}

export function exitStoreNeed(
  store: JitExitMaterializationStore,
  exitPoint: JitExitPoint,
  exitPointIndex: number
): JitMaterializationNeed {
  return {
    purpose: "exitStore",
    target: store.target,
    value: store.value,
    placement: {
      instructionIndex: exitPoint.instructionIndex,
      opIndex: exitPoint.opIndex,
      observationIndex: exitPointIndex,
      exitPointIndex,
      exitReason: exitPoint.exitReason,
      exitMaterializationIndex: exitPoint.exitMaterializationIndex
    },
    pathScope: exitPoint.pathScope
  };
}

export function exitPoint(input: Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitReason: ExitReason;
  observedState: JitExitStateSnapshot;
  exitMaterializationIndex: number;
  visibleEip?: JitObservationValue;
  payload?: JitObservationPayload;
  pathScope?: JitExitPoint["pathScope"];
}>): JitExitPoint {
  const visibleEip = input.visibleEip ?? { kind: "static", value: 0 };

  return {
    instructionIndex: input.instructionIndex,
    opIndex: input.opIndex,
    observedState: input.observedState,
    visibleEip,
    exitReason: input.exitReason,
    payload: input.payload ?? visibleEip,
    pathScope: input.pathScope ?? rootValuePathScope(),
    exitMaterializationIndex: input.exitMaterializationIndex
  };
}

export function instructionState(input: Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  instructionCountDelta: number;
  changedRegs?: readonly Reg32[];
  controlPathScopes?: JitInstructionState["controlPathScopes"];
  exitPointCount: number;
}>): JitInstructionState {
  const initialState = exitState(input.instructionCountDelta, input.changedRegs ?? []);

  return {
    instructionId: input.instructionId,
    eip: input.eip,
    nextEip: input.nextEip,
    nextMode: input.nextMode,
    instructionCountDelta: input.instructionCountDelta,
    initialValueState: initialState.valueState,
    controlPathScopes: input.controlPathScopes ?? new Map(),
    exitPointCount: input.exitPointCount
  };
}

export function exitState(
  instructionCountDelta: number,
  changedRegs: readonly Reg32[] = []
): JitExitStateSnapshot {
  const valueState = createJitValueState();

  for (const reg of changedRegs) {
    valueState.regs.writeReg32(reg, jitInputReg32Value(reg));
  }

  return {
    instructionCountDelta,
    valueState: valueState.snapshot()
  };
}

export function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

export function c32Expr(value: number): Extract<IrValueExpr, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

export function sourceRegExpr(reg: Reg32): IrValueExpr {
  return { kind: "source", source: { kind: "reg", reg }, accessWidth: 32 };
}

export function addExpr(reg: Reg32, value: number): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: sourceRegExpr(reg),
    b: c32Expr(value)
  };
}

export function addValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

export function subValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}
