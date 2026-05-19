import type { InstructionMetadata } from "#backends/wasm/jit/ir/types.js";
import type {
  BlockExpressions,
  InstructionExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import {
  analyzeInstructionEffects,
  timelineSnapshotPointsForExpressions,
  type EffectInstructionInput,
  type InstructionFlow
} from "./effects.js";
import type { Exit } from "./exits.js";
import { buildExpressionPaths } from "./paths.js";
import { buildTimeline } from "./timeline-builder.js";
import type { Timeline } from "./timeline-types.js";
import { instructionDeltaAfterOp } from "./instruction-progress.js";

export type { InstructionFlow } from "./effects.js";

export type InstructionAnalysis = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: InstructionExpressions;
  timeline: Timeline;
  flow: InstructionFlow<Exit>;
}>;

export type BlockAnalysis = Readonly<{
  instructions: readonly InstructionAnalysis[];
}>;

export function analyzeBlock(blockExpressions: BlockExpressions): BlockAnalysis {
  const instructionAnalyses: InstructionAnalysis[] = [];
  let instructionCountDelta = 0;
  let currentValueState = createJitValueState().snapshot();

  for (const [position, entry] of blockExpressions.instructions.entries()) {
    if (entry.index !== position) {
      throw new Error(
        `JIT block expressions index mismatch: ${entry.index} !== ${position}`
      );
    }

    const { instruction, index, expressions } = entry;
    const expressionPaths = buildExpressionPaths(expressions.block, index);
    const entryState = currentValueState;
    const timeline = buildTimeline({
      operands: instruction.operands,
      expressions: expressions.block,
      entry: entryState,
      snapshotPoints: timelineSnapshotPointsForExpressions(
        instruction,
        expressions.block
      ),
      nextEip: instruction.nextEip,
      producedByVar: expressions.producedValues
    });
    const progress = {
      instructionCountDelta
    };

    const effectInput: EffectInstructionInput = {
      instruction,
      index,
      expressions: expressions.block,
      timeline,
      expressionPaths,
      progress
    };

    instructionAnalyses.push({
      instruction,
      index,
      expressions,
      timeline,
      flow: analyzeInstructionEffects(effectInput)
    });
    instructionCountDelta += instructionDeltaForExpressions(instruction, expressions);
    currentValueState = timeline.finalState;
  }

  return {
    instructions: instructionAnalyses
  };
}

function instructionDeltaForExpressions(
  instruction: InstructionMetadata,
  expressions: InstructionExpressions
): number {
  let delta = 0;

  for (const op of expressions.block) {
    delta += instructionDeltaAfterOp(op, instruction);
  }

  return delta;
}
