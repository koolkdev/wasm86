import {
  buildIrExpressionBlock,
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitIrBlock,
  JitIrInstruction
} from "#backends/wasm/jit/ir/types.js";
import {
  buildJitBoundExpressionBlock,
  type JitBoundExprBlock,
  type JitBoundExprOp
} from "./bound-expressions.js";
import { validateBlockVarNamespace } from "./validate.js";

export type BlockExpressionProgress = Readonly<{
  instructionCountDelta: number;
}>;

export type BlockExprOp = Readonly<{
  opIndex: number;
  op: JitBoundExprOp;
  progress: BlockExpressionProgress;
}>;

export type BlockExpressions = Readonly<{
  ops: readonly BlockExprOp[];
  progress: BlockExpressionProgress;
}>;

export function buildBlockExpressions(block: JitIrBlock): BlockExpressions {
  validateBlockVarNamespace(block);

  const ops: BlockExprOp[] = [];
  let instructionCountDelta = 0;

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex]!;
    const progress = { instructionCountDelta };

    for (const op of buildInstructionExpressions(instruction)) {
      ops.push({
        opIndex: ops.length,
        op,
        progress
      });
    }

    if (instructionIndex < block.instructions.length - 1) {
      instructionCountDelta += 1;
    }
  }

  return {
    ops,
    progress: {
      instructionCountDelta
    }
  };
}

function buildInstructionExpressions(
  instruction: JitIrInstruction
): JitBoundExprBlock {
  return buildJitBoundExpressionBlock(
    buildIrExpressionBlock(instruction.ir),
    {
      eip: instruction.eip,
      nextEip: instruction.nextEip
    }
  );
}
