import type {
  IrExprBlock,
  IrExprOp
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { Timeline } from "#backends/wasm/jit/analysis/timeline.js";
import type { ValueUse } from "./value-uses.js";

export type JitValueCacheInstruction = Readonly<{
  operands: readonly JitOperandBinding[];
  valueTimeline: Timeline;
}>;

export type JitValueCacheInstructionPlan = JitValueCacheInstruction & Readonly<{
  opEpochs: readonly number[];
}>;

export type JitValueCachePlanInput = JitValueCacheInstruction & Readonly<{
  expressionBlock: IrExprBlock;
}>;

export type JitValueCacheEpochPlan = Readonly<{
  instructions: readonly JitValueCacheInstructionPlan[];
  consumerUses: readonly (readonly ValueUse[])[];
  definitionCaptures: readonly (readonly JitValue[])[];
}>;

export function planJitValueCacheEpochs(
  instructions: readonly JitValueCachePlanInput[],
  valueUses: readonly ValueUse[]
): JitValueCacheEpochPlan {
  const instructionPlans: JitValueCacheInstructionPlan[] = [];
  const definitionCaptures: JitValue[][] = [];
  const producedDefinitionCaptures = producedValueKeysNeededByConsumers(valueUses);
  let currentEpoch = 0;

  for (const instruction of instructions) {
    const opEpochs: number[] = [];
    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.writes.map((write) => write.opIndex)
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
    consumerUses: consumerUses(valueUses, epochCount),
    definitionCaptures: denseDefinitionCaptures(definitionCaptures, epochCount)
  };
}

export function jitExpressionOpEpochs(
  instruction: Pick<JitValueCachePlanInput, "expressionBlock" | "valueTimeline">,
  startEpoch = 0
): readonly number[] {
  const opEpochs: number[] = [];
  const writeExpressionOpIndexes = new Set(
    instruction.valueTimeline.writes.map((write) => write.opIndex)
  );
  let currentEpoch = startEpoch;

  for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
    const op = instruction.expressionBlock[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
    }

    opEpochs[opIndex] = currentEpoch;

    if (writeExpressionOpIndexes.has(opIndex)) {
      currentEpoch += 1;
    }
  }

  return opEpochs;
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

  const producedValue = instruction.valueTimeline.produced.find((definition) =>
    definition.opIndex === opIndex &&
    definition.ref.kind === "var" &&
    definition.ref.id === op.dst.id
  )?.value;

  if (
    producedValue === undefined ||
    !producedDefinitionCaptures.has(producedValueKey(producedValue))
  ) {
    return;
  }

  const epochCaptures = definitionCaptures[epochIndex] ?? [];

  if (!epochCaptures.some((value) => valuesEqual(value, producedValue))) {
    definitionCaptures[epochIndex] = [...epochCaptures, producedValue];
  }
}

function consumerUses(
  valueUses: readonly ValueUse[],
  epochCount: number
): readonly (readonly ValueUse[])[] {
  const epochUses: ValueUse[][] = Array.from(
    { length: epochCount },
    () => []
  );

  for (const use of valueUses) {
    const uses = epochUses[use.at.epoch];

    if (uses === undefined) {
      throw new Error(`JIT value use references missing epoch: ${use.at.epoch}`);
    }

    uses.push(use);
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
  valueUses: readonly ValueUse[]
): ReadonlySet<string> {
  const produced = new Set<string>();

  for (const use of valueUses) {
    if (use.value.kind === "produced") {
      produced.add(producedValueKey(use.value));
    }
  }

  return produced;
}

function producedValueKey(value: JitProducedValue): string {
  return `${value.type}:${value.id}`;
}
