import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";

export type JitExpressionUseInstructionInput = Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
}>;

export type JitPlacedSourceValueUse = Readonly<{
  value: JitValue;
  placement: Readonly<{
    instructionIndex: number;
    opIndex: number;
  }>;
}>;

export function placeJitValueUsesOnExpressions<TUse extends JitPlacedSourceValueUse>(
  instructions: readonly JitExpressionUseInstructionInput[],
  uses: readonly TUse[]
): readonly ReadonlyMap<number, readonly JitValue[]>[] {
  const usesByInstruction = instructions.map(() => new Map<number, JitValue[]>());

  for (const use of uses) {
    appendJitValueUse(usesByInstruction, instructions, use);
  }

  return usesByInstruction;
}

function appendJitValueUse(
  usesByInstruction: readonly Map<number, JitValue[]>[],
  instructions: readonly JitExpressionUseInstructionInput[],
  use: JitPlacedSourceValueUse
): void {
  const instructionIndex = use.placement.instructionIndex;
  const sourceOpIndex = use.placement.opIndex;
  const instruction = instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT instruction while placing value uses: ${instructionIndex}`);
  }

  for (const expressionOpIndex of expressionUseIndexesForSourceOp(instruction, sourceOpIndex)) {
    appendExpressionValueUse(
      usesByInstruction,
      instructionIndex,
      expressionOpIndex,
      use.value
    );
  }
}

function expressionUseIndexesForSourceOp(
  instruction: JitExpressionUseInstructionInput,
  sourceOpIndex: number
): readonly number[] {
  const placements = instruction.sourceExpressionMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [];
  const expressionIndexes = placements.flatMap((placement) =>
    placement.kind === "emittedOp" ? [placement.expressionOpIndex] : []
  );

  if (expressionIndexes.length === 0) {
    throw new Error(`could not map JIT source op to expression op: ${sourceOpIndex}`);
  }

  for (const expressionOpIndex of expressionIndexes) {
    if (instruction.expressionBlock[expressionOpIndex] === undefined) {
      throw new Error(`missing mapped JIT expression op: ${expressionOpIndex}`);
    }
  }

  return expressionIndexes;
}

function appendExpressionValueUse(
  usesByInstruction: readonly Map<number, JitValue[]>[],
  instructionIndex: number,
  expressionOpIndex: number,
  value: JitValue
): void {
  const usesByExpression = usesByInstruction[instructionIndex];

  if (usesByExpression === undefined) {
    throw new Error(`missing JIT instruction while placing value uses: ${instructionIndex}`);
  }

  const uses = usesByExpression.get(expressionOpIndex) ?? [];

  usesByExpression.set(expressionOpIndex, [...uses, value]);
}
