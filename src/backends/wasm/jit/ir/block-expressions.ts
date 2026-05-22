import {
  buildIrExpressionBlock,
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitIrBlock,
  JitIrInstruction
} from "#backends/wasm/jit/ir/types.js";
import {
  buildJitBoundExpressionBlock,
  type JitBoundExprBlock
} from "./bound-expressions.js";
import { validateBlockVarNamespace } from "./validate.js";

export function buildBlockExpressions(block: JitIrBlock): JitBoundExprBlock {
  validateBlockVarNamespace(block);

  const ops: JitBoundExprBlock[number][] = [];

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex]!;

    for (const op of buildInstructionExpressions(instruction)) {
      ops.push(op);
    }
  }

  return ops;
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
