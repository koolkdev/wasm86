import type { InstructionMetadata } from "#backends/wasm/jit/ir/types.js";
import type { BlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type { JitBoundExprBlock } from "#backends/wasm/jit/ir/bound-expressions.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import {
  analyzeInstructionEffects,
  timelineSnapshotPointsForExpressions,
  type EffectInstructionInput,
  type InstructionFlow
} from "./effects.js";
import type { Exit } from "./exits.js";
import { LoadResultRegistry } from "./load-result.js";
import { buildExpressionPaths } from "./paths.js";
import { buildTimeline } from "./timeline-builder.js";
import type { Timeline } from "./timeline-types.js";
import { instructionDeltaAfterOp } from "./instruction-progress.js";

export type { InstructionFlow } from "./effects.js";

export type InstructionAnalysis = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: JitBoundExprBlock;
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
  const loadResultRegistry = new LoadResultRegistry();

  for (const [position, entry] of blockExpressions.instructions.entries()) {
    if (entry.index !== position) {
      throw new Error(
        `JIT block expressions index mismatch: ${entry.index} !== ${position}`
      );
    }

    const { instruction, index, expressions } = entry;
    const isFinalInstruction = position === blockExpressions.instructions.length - 1;
    const expressionPaths = buildExpressionPaths(expressions, index);
    const entryState = currentValueState;
    const timeline = buildTimeline({
      expressions,
      entry: entryState,
      snapshotPoints: timelineSnapshotPointsForExpressions(
        isFinalInstruction,
        expressions
      ),
      loadResultRegistry
    });
    const progress = {
      instructionCountDelta
    };

    const effectInput: EffectInstructionInput = {
      instruction,
      index,
      expressions,
      timeline,
      expressionPaths,
      isFinalInstruction,
      progress
    };

    instructionAnalyses.push({
      instruction,
      index,
      expressions,
      timeline,
      flow: analyzeInstructionEffects(effectInput)
    });
    instructionCountDelta += instructionDeltaForExpressions(isFinalInstruction, expressions);
    currentValueState = timeline.finalState;
  }

  return {
    instructions: instructionAnalyses
  };
}

function instructionDeltaForExpressions(
  isFinalInstruction: boolean,
  expressions: JitBoundExprBlock
): number {
  let delta = 0;

  for (const op of expressions) {
    delta += instructionDeltaAfterOp(op, isFinalInstruction);
  }

  return delta;
}
