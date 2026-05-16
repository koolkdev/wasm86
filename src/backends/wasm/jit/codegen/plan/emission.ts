import {
  type IrExpressionOptions,
  type IrExprBlock,
  type IrExpressionSourceMap,
  buildIrExpressionBlockWithSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { indexProducedValues } from "#backends/wasm/jit/ir/produced-values.js";
import type { JitProducedValue } from "#backends/wasm/jit/ir/values/types.js";
import type { InstructionReusePlan } from "./reuse.js";
import {
  buildTimeline,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import type {
  JitCodegenPlan,
  JitInstructionState,
  PlannedExit,
  StoreStrategyPlan,
  StoreStrategySet
} from "./types.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";
import {
  planReuseForEmission,
  type InstructionWithReusePlan
} from "./value-planning.js";
import type { ValueUse } from "./value-uses.js";
import {
  buildExpressionPaths,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import {
  planEffects
} from "./effects-plan.js";
import type { EffectsPlan } from "./effect-types.js";
import { planStoreStrategy } from "./store-strategy.js";
import { collectValueUses } from "./value-uses.js";

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
  InstructionWithReusePlan<JitPreparedCodegenInstructionPlan>;

export type JitCodegenEmissionPlan = Readonly<{
  instructions: readonly JitCodegenInstructionPlan[];
  exits: readonly PlannedExit[];
  storeStrategy: StoreStrategyPlan;
  exitStoreSets: readonly StoreStrategySet[];
  maxExitStoreIndex: number;
  effects: EffectsPlan;
  valueUses: readonly ValueUse[];
  reusePlan: InstructionReusePlan;
}>;

export function buildJitCodegenEmissionPlan(codegenPlan: JitCodegenPlan): JitCodegenEmissionPlan {
  const block = codegenPlan.block;

  if (block.instructions.length !== codegenPlan.instructionStates.length) {
    throw new Error(
      `JIT codegen instruction count mismatch: ${block.instructions.length} !== ${codegenPlan.instructionStates.length}`
    );
  }

  const preparedInstructions = prepareJitCodegenInstructions(codegenPlan);
  const effects = planEffects({
    effects: codegenPlan.effects,
    instructions: preparedInstructions
  });
  const valueUses = collectValueUses({
    effects,
    exits: codegenPlan.exits
  });
  const plannedValues = planReuseForEmission(
    preparedInstructions,
    valueUses,
    codegenPlan.exits
  );
  const storeStrategy = planStoreStrategy({
    exits: codegenPlan.exits,
    captures: plannedValues.reusePlan.captures
  });

  return {
    instructions: plannedValues.instructions,
    exits: codegenPlan.exits,
    storeStrategy,
    exitStoreSets: storeStrategy.exitStoreSets,
    maxExitStoreIndex: storeStrategy.maxExitStoreIndex,
    effects,
    valueUses: plannedValues.valueUses,
    reusePlan: plannedValues.reusePlan
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
