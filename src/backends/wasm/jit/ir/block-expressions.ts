import {
  buildIrExpressionBlock,
  type IrExprBlock
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitIrBlock,
  JitIrInstruction,
  InstructionMetadata
} from "#backends/wasm/jit/ir/types.js";
import { indexProducedValues } from "./produced-values.js";
import type { JitProducedValue } from "./values/types.js";

export type InstructionExpressions = Readonly<{
  block: IrExprBlock;
  // Keyed by original IR variable id.
  producedValues: ReadonlyMap<number, JitProducedValue>;
}>;

export type BlockExpressionInstruction = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: InstructionExpressions;
}>;

export type BlockExpressions = Readonly<{
  instructions: readonly BlockExpressionInstruction[];
}>;

export function buildBlockExpressions(block: JitIrBlock): BlockExpressions {
  return {
    instructions: block.instructions.map((instruction, index) =>
      buildInstructionExpressions(instruction, index)
    )
  };
}

function buildInstructionExpressions(
  instruction: JitIrInstruction,
  index: number
): BlockExpressionInstruction {
  return {
    instruction: instructionMetadata(instruction),
    index,
    expressions: {
      block: buildIrExpressionBlock(instruction.ir),
      producedValues: indexProducedValues(instruction, index)
    }
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
