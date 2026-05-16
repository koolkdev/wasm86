import {
  type IrExpressionOptions,
  type IrExprBlock,
  type IrExpressionSourceMap,
  buildIrExpressionBlockWithSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { indexProducedValues } from "#backends/wasm/jit/ir/produced-values.js";
import type { JitProducedValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueCachePlan } from "./value-cache.js";
import {
  buildTimeline,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import type {
  JitCodegenPlan,
  ExitStoreSet,
  JitExitStoreUse,
  JitInstructionState,
  PlannedExit
} from "./types.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";
import {
  planJitValuesForEmission,
  type JitInstructionWithPlannedValues
} from "./value-planning.js";
import type { JitPlannedValueUse } from "./value-uses.js";
import type {
  JitPlannedValueCapture
} from "./value-captures.js";
import {
  buildExpressionPaths,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import {
  planJitEffectsForEmission,
  type JitPlannedEffect
} from "./effect-plan.js";

type JitPreparedCodegenInstruction = JitInstructionState & Pick<
  JitInstruction,
  "ir" | "operands"
> & Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPaths: PathMap;
  producedByVar: ReadonlyMap<number, JitProducedValue>;
  valueTimeline: Timeline;
}>;

type JitPreparedCodegenInstructionPlan = Omit<JitPreparedCodegenInstruction, "ir">;

export type JitCodegenInstructionPlan =
  JitInstructionWithPlannedValues<JitPreparedCodegenInstructionPlan>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exits: readonly PlannedExit[];
  exitStoreUses: readonly JitExitStoreUse[];
  exitStoreSets: readonly ExitStoreSet[];
  maxExitStoreIndex: number;
  plannedEffects: readonly JitPlannedEffect[];
  plannedValueUses: readonly JitPlannedValueUse[];
  plannedValueCaptures: readonly JitPlannedValueCapture[];
  valueCachePlan: JitValueCachePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const block = codegenPlan.block;

  if (block.instructions.length !== codegenPlan.instructionStates.length) {
    throw new Error(
      `JIT codegen instruction count mismatch: ${block.instructions.length} !== ${codegenPlan.instructionStates.length}`
    );
  }

  const preparedInstructions = prepareJitCodegenInstructions(codegenPlan);
  const plannedEffects = planJitEffectsForEmission(
    preparedInstructions,
    codegenPlan.effects,
    codegenPlan.exitStoreUses
  );
  const plannedValues = planJitValuesForEmission(
    preparedInstructions,
    plannedEffects.plannedValueUses
  );

  return {
    instructions: plannedValues.instructions,
    exits: codegenPlan.exits,
    exitStoreUses: codegenPlan.exitStoreUses,
    exitStoreSets: codegenPlan.exitStoreSets,
    maxExitStoreIndex: codegenPlan.maxExitStoreIndex,
    plannedEffects: plannedEffects.plannedEffects,
    plannedValueUses: plannedValues.plannedValueUses,
    plannedValueCaptures: plannedValues.plannedValueCaptures,
    valueCachePlan: plannedValues.valueCachePlan
  };
}

function prepareJitCodegenInstructions(
  codegenPlan: JitCodegenPlan
): readonly JitPreparedCodegenInstruction[] {
  return codegenPlan.block.instructions.map((instruction, index) =>
    prepareJitCodegenInstruction(
      instruction,
      index,
      requiredInstructionState(codegenPlan, index)
    )
  );
}

function prepareJitCodegenInstruction(
  instruction: JitInstruction,
  instructionIndex: number,
  state: JitInstructionState
): JitPreparedCodegenInstruction {
  const expressionPlan = buildIrExpressionBlockWithSourceMap(
    instruction.ir,
    jitExpressionOptions(instruction)
  );
  const producedByVar = indexProducedValues(
    instruction,
    instructionIndex
  );
  const valueTimeline = buildTimeline({
    operands: instruction.operands,
    expressions: expressionPlan.expressionBlock,
    entry: state.initialValueState,
    producedByVar
  });
  const expressionPaths = buildExpressionPaths(
    state.paths,
    expressionPlan.sourceMap,
    instructionIndex
  );

  return {
    ...state,
    ir: instruction.ir,
    operands: instruction.operands,
    producedByVar,
    valueTimeline,
    expressionBlock: expressionPlan.expressionBlock,
    sourceExpressionMap: expressionPlan.sourceMap,
    expressionPaths
  };
}

function requiredInstructionState(
  codegenPlan: JitCodegenPlan,
  instructionIndex: number
): JitInstructionState {
  const state = codegenPlan.instructionStates[instructionIndex];

  if (state === undefined) {
    throw new Error(`missing JIT instruction state for codegen: ${instructionIndex}`);
  }

  return state;
}

function jitExpressionOptions(instruction: Pick<JitInstruction, "operands">): IrExpressionOptions {
  return {
    canInlineGet: (source) => canInlineJitInstructionGet(instruction, source),
    alias: {
      storageMayAlias: (write, read) => jitInstructionStorageRefsMayAlias(instruction, write, read)
    }
  };
}
