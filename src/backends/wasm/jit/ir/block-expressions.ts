import {
  buildIrExpressionBlockWithSourceMap,
  type IrExprBlock,
  type IrExpressionOptions,
  type IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitBlock, JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { indexProducedValues } from "./produced-values.js";
import type { JitProducedValue } from "./values/types.js";
import { createOperandResolver } from "./operand-resolver.js";

export type InstructionExpressions = Readonly<{
  block: IrExprBlock;
  sourceMap: IrExpressionSourceMap;
  // Keyed by source IR variable id.
  producedValues: ReadonlyMap<number, JitProducedValue>;
}>;

export type BlockExpressionInstruction = Readonly<{
  instruction: JitInstruction;
  index: number;
  expressions: InstructionExpressions;
}>;

export type BlockExpressions = Readonly<{
  instructions: readonly BlockExpressionInstruction[];
}>;

export function buildBlockExpressions(block: JitBlock): BlockExpressions {
  return {
    instructions: block.instructions.map((instruction, index) =>
      buildInstructionExpressions(instruction, index)
    )
  };
}

function buildInstructionExpressions(
  instruction: JitInstruction,
  index: number
): BlockExpressionInstruction {
  const expressionPlan = buildIrExpressionBlockWithSourceMap(
    instruction.ir,
    expressionOptionsForInstruction(instruction)
  );

  return {
    instruction,
    index,
    expressions: {
      block: expressionPlan.expressionBlock,
      sourceMap: expressionPlan.sourceMap,
      producedValues: indexProducedValues(instruction, index)
    }
  };
}

function expressionOptionsForInstruction(
  instruction: Pick<JitInstruction, "operands">
): IrExpressionOptions {
  const operands = createOperandResolver(instruction.operands);

  return {
    canInlineGet: operands.canInlineGet,
    alias: {
      storageMayAlias: operands.storageMayAlias
    }
  };
}
