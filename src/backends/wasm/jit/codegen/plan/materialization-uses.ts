import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";
import type {
  JitCodegenPlan,
  JitMaterializationNeed
} from "./types.js";

export type JitMaterializationUsePlanInput = Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
}>;

export type JitMaterializationUsePlacementPlan = Readonly<{
  jitValueUsesByInstruction: readonly ReadonlyMap<number, readonly JitValue[]>[];
}>;

export function planJitMaterializationUses(
  instructions: readonly JitMaterializationUsePlanInput[],
  codegenPlan: Pick<
    JitCodegenPlan,
    "block" | "materializationNeeds"
  >
): JitMaterializationUsePlacementPlan {
  if (instructions.length !== codegenPlan.block.instructions.length) {
    throw new Error(
      `JIT materialization-use instruction count mismatch: ${instructions.length} !== ${codegenPlan.block.instructions.length}`
    );
  }

  const jitValueUsesByInstruction = instructions.map(() => new Map<number, JitValue[]>());

  for (const need of codegenPlan.materializationNeeds) {
    if (need.consumer !== "registerExitStore") {
      continue;
    }

    appendRegisterMaterializationNeedUse(
      jitValueUsesByInstruction,
      instructions,
      codegenPlan,
      need
    );
  }

  return { jitValueUsesByInstruction };
}

function appendRegisterMaterializationNeedUse(
  usesByInstruction: readonly Map<number, JitValue[]>[],
  instructions: readonly JitMaterializationUsePlanInput[],
  codegenPlan: Pick<JitCodegenPlan, "block">,
  need: Extract<JitMaterializationNeed, { consumer: "registerExitStore" }>
): void {
  const instructionIndex = need.placement.instructionIndex;
  const sourceOpIndex = need.placement.opIndex;
  const sourceInstruction = codegenPlan.block.instructions[instructionIndex];
  const instruction = instructions[instructionIndex];

  if (sourceInstruction === undefined || instruction === undefined) {
    throw new Error(`missing JIT instruction while planning materialization uses: ${instructionIndex}`);
  }

  if (sourceInstruction.ir[sourceOpIndex] === undefined) {
    throw new Error(`missing JIT IR op while planning materialization uses: ${instructionIndex}:${sourceOpIndex}`);
  }

  for (const expressionOpIndex of expressionUseIndexesForSourceOp(instruction, sourceOpIndex)) {
    appendExpressionUse(
      usesByInstruction,
      instructionIndex,
      expressionOpIndex,
      need.value
    );
  }
}

function expressionUseIndexesForSourceOp(
  instruction: JitMaterializationUsePlanInput,
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

function appendExpressionUse(
  usesByInstruction: readonly Map<number, JitValue[]>[],
  instructionIndex: number,
  expressionOpIndex: number,
  value: JitValue
): void {
  const usesByExpression = usesByInstruction[instructionIndex];

  if (usesByExpression === undefined) {
    throw new Error(`missing JIT instruction while planning materialization uses: ${instructionIndex}`);
  }

  const uses = usesByExpression.get(expressionOpIndex) ?? [];

  usesByExpression.set(expressionOpIndex, [...uses, value]);
}
