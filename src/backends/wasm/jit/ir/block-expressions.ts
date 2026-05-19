import {
  buildIrExpressionBlock,
  type IrExprBlock
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitIrBlock,
  JitIrInstruction,
  InstructionMetadata
} from "#backends/wasm/jit/ir/types.js";

export type BlockExpressionInstruction = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: IrExprBlock;
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
  return {
    instruction: instructionMetadata(instruction),
    index,
    expressions: buildIrExpressionBlock(instruction.ir)
  };
}

function instructionMetadata(instruction: JitIrInstruction): InstructionMetadata {
  return {
    instructionId: instruction.instructionId,
    eip: instruction.eip,
    nextEip: instruction.nextEip,
    nextMode: instruction.nextMode,
    operands: instruction.operands
  };
}
