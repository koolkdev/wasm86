import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type {
  BlockExpressions,
  InstructionExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import {
  analyzeInstructionEffects,
  type EffectInstructionInput,
  type InstructionFlow
} from "./effects.js";
import type { Exit } from "./exits.js";
import { buildInstructionPaths } from "./paths.js";
import { buildTimeline, type Timeline } from "./timeline.js";
import { instructionDeltaAfterOp } from "./instruction-progress.js";

export type { InstructionFlow } from "./effects.js";

export type InstructionAnalysis = Readonly<{
  instruction: JitInstruction;
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
    const sourcePaths = buildInstructionPaths(instruction, index);
    const entryState = currentValueState;
    const timeline = buildTimeline({
      operands: instruction.operands,
      expressions: expressions.block,
      entry: entryState,
      producedByVar: expressions.producedValues
    });
    const progress = {
      instructionCountDelta
    };

    const effectInput: EffectInstructionInput = {
      instruction,
      index,
      sourceMap: expressions.sourceMap,
      timeline,
      sourcePaths,
      progress
    };

    instructionAnalyses.push({
      instruction,
      index,
      expressions,
      timeline,
      flow: analyzeInstructionEffects(effectInput)
    });
    instructionCountDelta += instructionDeltaForInstruction(instruction);
    currentValueState = timeline.final;
  }

  return {
    instructions: instructionAnalyses
  };
}

function instructionDeltaForInstruction(instruction: JitInstruction): number {
  let delta = 0;

  for (const op of instruction.ir) {
    delta += instructionDeltaAfterOp(op, instruction);
  }

  return delta;
}
