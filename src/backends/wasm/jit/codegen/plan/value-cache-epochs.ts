import type {
  IrExprBlock,
  IrExprOp
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { jitValuesEqual } from "#backends/wasm/jit/ir/value-equality.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";
import type { JitInstructionValueTimeline } from "./value-timeline.js";
import type { JitValueSelectionUse } from "./value-cache-selection.js";
import { cacheSelectionUsesForPlannedUse } from "./value-cache-uses.js";
import type { JitPlannedValueUse } from "./value-uses.js";

export type JitValueCacheInstruction = Readonly<{
  operands: readonly JitOperandBinding[];
  valueTimeline: JitInstructionValueTimeline;
}>;

export type JitValueCacheInstructionPlan = JitValueCacheInstruction & Readonly<{
  opEpochs: readonly number[];
}>;

export type JitValueCachePlanInput = JitValueCacheInstruction & Readonly<{
  expressionBlock: IrExprBlock;
}>;

export type JitValueCacheEpochPlan = Readonly<{
  instructions: readonly JitValueCacheInstructionPlan[];
  consumerUses: readonly (readonly JitValueSelectionUse[])[];
  definitionCaptures: readonly (readonly JitValue[])[];
}>;

export function planJitValueCacheEpochs(
  instructions: readonly JitValueCachePlanInput[],
  plannedValueUses: readonly JitPlannedValueUse[]
): JitValueCacheEpochPlan {
  const instructionPlans: JitValueCacheInstructionPlan[] = [];
  const definitionCaptures: JitValue[][] = [];
  const producedDefinitionCaptures = producedValueKeysNeededByConsumers(plannedValueUses);
  let currentEpoch = 0;

  for (const instruction of instructions) {
    const opEpochs: number[] = [];
    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.logicalWrites.map((write) => write.expressionOpIndex)
    );

    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
      }

      opEpochs[opIndex] = currentEpoch;
      appendProducedDefinitionCapture(
        definitionCaptures,
        currentEpoch,
        instruction,
        op,
        opIndex,
        producedDefinitionCaptures
      );

      if (writeExpressionOpIndexes.has(opIndex)) {
        currentEpoch += 1;
      }
    }

    instructionPlans.push({
      operands: instruction.operands,
      valueTimeline: instruction.valueTimeline,
      opEpochs
    });
  }

  const epochCount = currentEpoch + 1;

  return {
    instructions: instructionPlans,
    consumerUses: consumerUses(plannedValueUses, epochCount),
    definitionCaptures: denseDefinitionCaptures(definitionCaptures, epochCount)
  };
}

function appendProducedDefinitionCapture(
  definitionCaptures: JitValue[][],
  epochIndex: number,
  instruction: JitValueCacheInstruction,
  op: IrExprOp,
  opIndex: number,
  producedDefinitionCaptures: ReadonlySet<string>
): void {
  if (op.op !== "let32") {
    return;
  }

  const producedValue = instruction.valueTimeline.producedDefinitions.find((definition) =>
    definition.expressionOpIndex === opIndex &&
    definition.valueRef.kind === "var" &&
    definition.valueRef.id === op.dst.id
  )?.value;

  if (
    producedValue === undefined ||
    !producedDefinitionCaptures.has(producedValueKey(producedValue))
  ) {
    return;
  }

  const epochCaptures = definitionCaptures[epochIndex] ?? [];

  if (!epochCaptures.some((value) => jitValuesEqual(value, producedValue))) {
    definitionCaptures[epochIndex] = [...epochCaptures, producedValue];
  }
}

function consumerUses(
  plannedValueUses: readonly JitPlannedValueUse[],
  epochCount: number
): readonly (readonly JitValueSelectionUse[])[] {
  const epochUses: JitValueSelectionUse[][] = Array.from(
    { length: epochCount },
    () => []
  );

  for (const use of plannedValueUses) {
    const uses = epochUses[use.placement.epoch];

    if (uses === undefined) {
      throw new Error(`planned JIT value use references missing epoch: ${use.placement.epoch}`);
    }

    uses.push(...cacheSelectionUsesForPlannedUse(use).map((cacheUse) => ({
      value: cacheUse.value,
      emittedCost: cacheUse.emittedCost,
      ancestors: cacheUse.ancestors
    })));
  }

  return epochUses;
}

function denseDefinitionCaptures(
  definitionCaptures: readonly (readonly JitValue[] | undefined)[],
  epochCount: number
): readonly (readonly JitValue[])[] {
  return Array.from({ length: epochCount }, (_entry, epochIndex) =>
    definitionCaptures[epochIndex] ?? []
  );
}

function producedValueKeysNeededByConsumers(
  plannedValueUses: readonly JitPlannedValueUse[]
): ReadonlySet<string> {
  const produced = new Set<string>();

  for (const use of plannedValueUses) {
    for (const cacheUse of cacheSelectionUsesForPlannedUse(use)) {
      if (cacheUse.value.kind === "produced") {
        produced.add(producedValueKey(cacheUse.value));
      }
    }
  }

  return produced;
}

function producedValueKey(value: JitProducedValue): string {
  return `${value.type}:${value.id}`;
}
