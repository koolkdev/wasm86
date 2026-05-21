import {
  buildIrExpressionBlock,
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitIrBlock,
  JitIrInstruction,
  InstructionMetadata
} from "#backends/wasm/jit/ir/types.js";
import {
  buildJitBoundExpressionBlock,
  type JitBoundExprBlock
} from "./bound-expressions.js";

export type BlockExpressionInstruction = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: JitBoundExprBlock;
}>;

export type BlockExpressions = Readonly<{
  instructions: readonly BlockExpressionInstruction[];
}>;

export function buildBlockExpressions(block: JitIrBlock): BlockExpressions {
  return {
    instructions: block.instructions.map((instruction, index) =>
      buildBlockExpressionInstruction(instruction, index)
    )
  };
}

function buildBlockExpressionInstruction(
  instruction: JitIrInstruction,
  index: number
): BlockExpressionInstruction {
  const expressions = buildJitBoundExpressionBlock(
    buildIrExpressionBlock(instruction.ir),
    {
      eip: instruction.eip,
      nextEip: instruction.nextEip
    }
  );

  return {
    instruction: instructionMetadata(instruction),
    index,
    expressions
  };
}

function instructionMetadata(instruction: JitIrInstruction): InstructionMetadata {
  return {
    instructionId: instruction.instructionId,
    eip: instruction.eip
  };
}
