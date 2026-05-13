import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { Reg32 } from "#x86/isa/types.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import {
  afterOp,
  beforeOp,
  instructionEntry,
  instructionExit,
  planJitCodegen
} from "#backends/wasm/jit/codegen/plan/plan.js";
import { planJitExpressionValueCacheForInstructions } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  JitBoundaryRef,
  JitBoundaryState,
  JitCodegenPlan,
  JitExitMaterializationStore,
  JitExitPoint,
  JitInstructionEntryPoint,
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
  afterOp,
  beforeOp,
  instructionEntry,
  instructionExit,
  planJitCodegen,
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
  JitOperandBinding,
  JitCodegenPlan,
  JitExitMaterializationStore,
  JitExitPoint,
  JitInstructionEntryPoint,
  JitMaterializationNeed,
  JitObservationPayload,
  JitObservationValue,
  JitBoundaryState,
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
    consumer: store.target.kind === "aluFlags" ? "flagExitStore" : "registerExitStore",
    target: store.target,
    value: store.value,
    placement: {
      instructionIndex: exitPoint.instructionIndex,
      opIndex: exitPoint.opIndex,
      emitBoundary: exitPoint.emitBoundary,
      observedBoundary: exitPoint.observedBoundary,
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
  observedState: JitBoundaryState;
  exitMaterializationIndex: number;
  visibleEip?: JitObservationValue;
  payload?: JitObservationPayload;
  pathScope?: JitExitPoint["pathScope"];
}>): JitExitPoint {
  const emitBoundary = beforeOp(input.instructionIndex, input.opIndex);
  const visibleEip = input.visibleEip ?? { kind: "static", value: 0 };

  return {
    instructionIndex: input.instructionIndex,
    opIndex: input.opIndex,
    emitBoundary,
    observedBoundary: input.observedState.boundary,
    observedState: input.observedState,
    visibleEip,
    exitReason: input.exitReason,
    payload: input.payload ?? visibleEip,
    pathScope: input.pathScope ?? "deferredExit",
    exitMaterializationIndex: input.exitMaterializationIndex
  };
}

export function instructionEntryPoint(
  instructionIndex: number,
  boundaryState: JitBoundaryState,
  overrides: Partial<Pick<
    JitInstructionEntryPoint,
    "preInstructionExitPlan"
  >> = {}
): JitInstructionEntryPoint {
  return {
    instructionIndex,
    boundaryState,
    ...overrides
  };
}

export function boundaryState(
  boundary: JitBoundaryRef,
  instructionCountDelta: number,
  changedRegs: readonly Reg32[] = []
): JitBoundaryState {
  const valueState = createJitValueState();

  for (const reg of changedRegs) {
    valueState.regs.writeReg32(reg, jitInputReg32Value(reg));
  }

  return {
    boundary,
    instructionCountDelta,
    valueState: valueState.snapshot()
  };
}

export function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

export function addValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

export function subValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}
