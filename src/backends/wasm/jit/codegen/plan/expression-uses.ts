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
  return placeJitValueUseRecordsOnExpressions(instructions, uses).map((usesByExpression) => {
    const valuesByExpression = new Map<number, JitValue[]>();

    for (const [expressionIndex, expressionUses] of usesByExpression) {
      valuesByExpression.set(expressionIndex, expressionUses.map((use) => use.value));
    }

    return valuesByExpression;
  });
}

export function placeJitValueUseRecordsOnExpressions<TUse extends JitPlacedSourceValueUse>(
  instructions: readonly JitExpressionUseInstructionInput[],
  uses: readonly TUse[]
): readonly ReadonlyMap<number, readonly TUse[]>[] {
  const usesByInstruction = instructions.map(() => new Map<number, TUse[]>());

  for (const use of uses) {
    appendJitValueUse(usesByInstruction, instructions, use);
  }

  return usesByInstruction;
}

function appendJitValueUse<TUse extends JitPlacedSourceValueUse>(
  usesByInstruction: readonly Map<number, TUse[]>[],
  instructions: readonly JitExpressionUseInstructionInput[],
  use: TUse
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
      use
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

function appendExpressionValueUse<TUse extends JitPlacedSourceValueUse>(
  usesByInstruction: readonly Map<number, TUse[]>[],
  instructionIndex: number,
  expressionOpIndex: number,
  use: TUse
): void {
  const usesByExpression = usesByInstruction[instructionIndex];

  if (usesByExpression === undefined) {
    throw new Error(`missing JIT instruction while placing value uses: ${instructionIndex}`);
  }

  const uses = usesByExpression.get(expressionOpIndex) ?? [];

  usesByExpression.set(expressionOpIndex, [...uses, use]);
}
