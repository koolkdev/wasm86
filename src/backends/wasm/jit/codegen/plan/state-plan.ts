import {
  buildIrExpressionBlockWithSourceMap,
  type IrExpressionOptions
} from "#backends/wasm/codegen/expressions.js";
import type { JitBlock, JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeEffects,
  reattachEffectExits,
  type InstructionAnalysis
} from "#backends/wasm/jit/analysis/effects.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { indexProducedValues } from "#backends/wasm/jit/ir/produced-values.js";
import type {
  JitCodegenPlan,
  JitInstructionState
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  buildInstructionPaths
} from "#backends/wasm/jit/analysis/paths.js";
import {
  instructionDeltaAfterOp
} from "#backends/wasm/jit/analysis/instruction-progress.js";
import { planJitExitStores } from "./exit-stores.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";

export function analyzeJitCodegenState(
  block: JitBlock
): Omit<JitCodegenPlan, "block"> {
  const instructionStates: JitInstructionState[] = [];
  const instructionAnalyses: InstructionAnalysis[] = [];
  let instructionCountDelta = 0;
  let currentValueState = createJitValueState().snapshot();

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    const initialInstructionCountDelta = instructionCountDelta;
    const initialValueState = currentValueState;
    const expressionPlan = buildIrExpressionBlockWithSourceMap(
      instruction.ir,
      jitExpressionOptions(instruction)
    );
    const valueTimeline = buildTimeline({
      operands: instruction.operands,
      expressions: expressionPlan.expressionBlock,
      entry: initialValueState,
      producedByVar: indexProducedValues(instruction, instructionIndex)
    });
    const paths = buildInstructionPaths(
      instruction,
      instructionIndex
    );

    instructionAnalyses.push({
      instruction,
      instructionIndex,
      sourceMap: expressionPlan.sourceMap,
      valueTimeline,
      paths
    });
    instructionStates.push({
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      instructionCountDelta: initialInstructionCountDelta,
      initialValueState,
      paths,
      exitCount: 0
    });

    instructionCountDelta += instructionDeltaForInstruction(instruction);
    currentValueState = valueTimeline.final;
  }

  const effectAnalysis = analyzeEffects({
    instructions: instructionAnalyses
  });
  const exitStorePlan = planJitExitStores(effectAnalysis.exits);
  const effects = reattachEffectExits(
    effectAnalysis.effects,
    exitStorePlan.exits
  );
  const exitCounts = countExitsByInstruction(exitStorePlan.exits, block.instructions.length);

  return {
    instructionStates: instructionStates.map((state, index) => ({
      ...state,
      exitCount: exitCounts[index] ?? 0
    })),
    effects,
    exits: exitStorePlan.exits,
    materializationNeeds: exitStorePlan.materializationNeeds,
    exitMaterializations: exitStorePlan.exitMaterializations,
    maxExitMaterializationIndex: exitStorePlan.maxExitMaterializationIndex
  };
}

function instructionDeltaForInstruction(instruction: JitInstruction): number {
  let delta = 0;

  for (const op of instruction.ir) {
    delta += instructionDeltaAfterOp(op, instruction);
  }

  return delta;
}

function countExitsByInstruction(
  exits: readonly import("./types.js").PlannedExit[],
  instructionCount: number
): readonly number[] {
  const counts = Array.from({ length: instructionCount }, () => 0);

  for (const exit of exits) {
    counts[exit.at.instructionIndex] = (counts[exit.at.instructionIndex] ?? 0) + 1;
  }

  return counts;
}

function jitExpressionOptions(instruction: Pick<JitInstruction, "operands">): IrExpressionOptions {
  return {
    canInlineGet: (source) => canInlineJitInstructionGet(instruction, source),
    alias: {
      storageMayAlias: (write, read) => jitInstructionStorageRefsMayAlias(instruction, write, read)
    }
  };
}
