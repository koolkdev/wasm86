import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import {
  jitValueCost,
  simplifyJitValue,
  jitValuesEqual,
  jitValueDependencies,
  type JitProducedValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt,
  type JitInstructionValueTimeline
} from "./value-timeline.js";
import {
  flattenJitValueSelectionUses,
  mergeSelectedUseCounts,
  selectConsumerValuesByEpoch,
  type JitValueSelectionUse,
  type JitValueUseCount
} from "./value-cache-selection.js";

export type { JitValueUseCount } from "./value-cache-selection.js";

export type JitExpressionValueCachePlan = Readonly<{
  instructionPlans: readonly JitInstructionValueCachePlan[];
  selectedConsumerValuesByEpoch: readonly (readonly JitValueUseCount[])[];
  captureValuesByEpoch: readonly (readonly JitValue[])[];
  selectedUseCounts: readonly JitValueUseCount[];
}>;

export type JitExpressionValueCacheInstruction = Readonly<{
  operands: readonly JitOperandBinding[];
  valueTimeline: JitInstructionValueTimeline;
  materializationJitValueUsesByExpressionIndex?: ReadonlyMap<number, readonly JitValue[]>;
}>;

export type JitInstructionValueCachePlan = JitExpressionValueCacheInstruction & Readonly<{
  epochByExpressionOpIndex: readonly number[];
}>;

export type JitExpressionValueCachePlanInput = JitExpressionValueCacheInstruction & Readonly<{
  expressionBlock: IrExprBlock;
}>;

type JitValueEpochUses = Readonly<{
  consumerUsesByEpoch: readonly (readonly JitValueSelectionUse[])[];
  captureValuesByEpoch: readonly (readonly JitValue[])[];
}>;

export function planJitExpressionValueCache(
  instruction: JitExpressionValueCacheInstruction,
  expressionBlock: IrExprBlock
): JitExpressionValueCachePlan | undefined {
  return planJitExpressionValueCacheForInstructions([{ ...instruction, expressionBlock }]);
}

export function planJitExpressionValueCacheForInstructions(
  instructions: readonly JitExpressionValueCachePlanInput[]
): JitExpressionValueCachePlan | undefined {
  const instructionPlans: JitInstructionValueCachePlan[] = [];
  const epochUses = expressionValueUseEpochs(instructions, instructionPlans);
  const selectedConsumerValuesByEpoch = selectConsumerValuesByEpoch(epochUses.consumerUsesByEpoch);
  const selectedUseCounts = mergeSelectedUseCounts(selectedConsumerValuesByEpoch);

  return selectedUseCounts.length === 0
    ? undefined
    : {
        instructionPlans,
        selectedConsumerValuesByEpoch,
        captureValuesByEpoch: epochUses.captureValuesByEpoch,
        selectedUseCounts
      };
}

function expressionValueUseEpochs(
  instructions: readonly JitExpressionValueCachePlanInput[],
  instructionPlans: JitInstructionValueCachePlan[]
): JitValueEpochUses {
  const epochs: JitValueSelectionUse[][] = [];
  const captureValuesByEpoch: JitValue[][] = [];
  const producedDefinitionCaptures = producedValueKeysNeededByConsumers(instructions);
  let currentEpoch: JitValueSelectionUse[] = [];

  for (const instruction of instructions) {
    const epochByExpressionOpIndex: number[] = [];
    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.logicalWrites.map((write) => write.expressionOpIndex)
    );

    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
      }

      epochByExpressionOpIndex[opIndex] = epochs.length;
      currentEpoch.push(...valueUsesForOp(instruction, op, opIndex));
      appendProducedDefinitionCapture(
        captureValuesByEpoch,
        epochs.length,
        instruction,
        op,
        opIndex,
        producedDefinitionCaptures
      );

      if (writeExpressionOpIndexes.has(opIndex)) {
        epochs.push(currentEpoch);
        currentEpoch = [];
      }
    }

    instructionPlans.push({
      operands: instruction.operands,
      valueTimeline: instruction.valueTimeline,
      ...(instruction.materializationJitValueUsesByExpressionIndex === undefined
        ? {}
        : { materializationJitValueUsesByExpressionIndex: instruction.materializationJitValueUsesByExpressionIndex }),
      epochByExpressionOpIndex
    });
  }

  epochs.push(currentEpoch);
  return {
    consumerUsesByEpoch: epochs,
    captureValuesByEpoch: denseCaptureValuesByEpoch(captureValuesByEpoch, epochs.length)
  };
}

function valueUsesForOp(
  instruction: JitExpressionValueCacheInstruction,
  op: IrExprOp,
  opIndex: number
): readonly JitValueSelectionUse[] {
  const opUses = (() => {
    switch (op.op) {
    case "let32":
      return [];
    case "set": {
      const stateUpdateOnly = instructionHasLogicalWriteAt(instruction, opIndex);

      return [
        ...valueUsesForStorage(instruction, op.target, opIndex),
        ...(stateUpdateOnly
          ? []
          : valueUsesForValue(instruction, op.value, opIndex))
      ];
    }
    case "flags.set":
      return [];
    case "jump":
      return valueUsesForValue(instruction, op.target, opIndex);
    case "conditionalJump":
      return [
        ...valueUsesForValue(instruction, op.condition, opIndex),
        ...valueUsesForValue(instruction, op.taken, opIndex),
        ...valueUsesForValue(instruction, op.notTaken, opIndex)
      ];
    case "hostTrap":
      return valueUsesForValue(instruction, op.vector, opIndex);
    case "next":
      return [];
    }
  })();

  return [
    ...opUses,
    ...materializationJitValueUsesForOp(instruction, opIndex)
  ];
}

function appendProducedDefinitionCapture(
  captureValuesByEpoch: JitValue[][],
  epochIndex: number,
  instruction: JitExpressionValueCacheInstruction,
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

  const epochCaptures = captureValuesByEpoch[epochIndex] ?? [];

  if (!epochCaptures.some((value) => jitValuesEqual(value, producedValue))) {
    captureValuesByEpoch[epochIndex] = [...epochCaptures, producedValue];
  }
}

function denseCaptureValuesByEpoch(
  captureValuesByEpoch: readonly (readonly JitValue[] | undefined)[],
  epochCount: number
): readonly (readonly JitValue[])[] {
  return Array.from({ length: epochCount }, (_, epochIndex) =>
    captureValuesByEpoch[epochIndex] ?? []
  );
}

function valueUsesForStorage(
  instruction: JitExpressionValueCacheInstruction,
  storage: IrStorageExpr,
  opIndex: number
): readonly JitValueSelectionUse[] {
  return storage.kind === "mem"
    ? valueUsesForValue(instruction, storage.address, opIndex)
    : [];
}

function valueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  opIndex: number
): readonly JitValueSelectionUse[] {
  const jitValue = jitValueForValue(instruction, value, opIndex);

  return jitValue === undefined
    ? childValueUsesForValue(instruction, value, opIndex)
    : [jitValueUseTree(jitValue)];
}

function childValueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  opIndex: number
): readonly JitValueSelectionUse[] {
  switch (value.kind) {
    case "source":
      return valueUsesForStorage(instruction, value.source, opIndex);
    case "value.binary":
      return [
        ...valueUsesForValue(instruction, value.a, opIndex),
        ...valueUsesForValue(instruction, value.b, opIndex)
      ];
    case "value.unary":
      return valueUsesForValue(instruction, value.value, opIndex);
    case "value.select":
      return [
        ...valueUsesForValue(instruction, value.condition, opIndex),
        ...valueUsesForValue(instruction, value.whenTrue, opIndex),
        ...valueUsesForValue(instruction, value.whenFalse, opIndex)
      ];
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return [];
  }
}

function materializationJitValueUsesForOp(
  instruction: JitExpressionValueCacheInstruction,
  opIndex: number
): readonly JitValueSelectionUse[] {
  return (instruction.materializationJitValueUsesByExpressionIndex?.get(opIndex) ?? [])
    .map((value) => jitValueUseTree(value));
}

function producedValueKeysNeededByConsumers(
  instructions: readonly JitExpressionValueCachePlanInput[]
): ReadonlySet<string> {
  const produced = new Set<string>();

  for (const instruction of instructions) {
    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value-cache expression op while collecting produced captures: ${opIndex}`);
      }

      for (const use of flattenJitValueSelectionUses(valueUsesForOp(instruction, op, opIndex))) {
        if (use.value.kind === "produced") {
          produced.add(producedValueKey(use.value));
        }
      }
    }
  }

  return produced;
}

function producedValueKey(value: JitProducedValue): string {
  return `${value.type}:${value.id}`;
}

function jitValueUseTree(value: JitValue): JitValueSelectionUse {
  const simplified = simplifyJitValue(value);

  return {
    value: simplified,
    emittedCost: jitValueCost(simplified),
    children: jitValueDependencies(simplified).map((dependency) => jitValueUseTree(dependency))
  };
}

function jitValueForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  opIndex: number
): JitValue | undefined {
  switch (value.kind) {
    case "var":
    case "const":
    case "nextEip":
      return jitTimelineValueRefValueAt(instruction.valueTimeline, opIndex, value);
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return jitTimelineExpressionValueAt(instruction.valueTimeline, opIndex, value);
  }
}

function instructionHasLogicalWriteAt(
  instruction: JitExpressionValueCacheInstruction,
  opIndex: number
): boolean {
  return instruction.valueTimeline.logicalWrites.some((write) =>
    write.expressionOpIndex === opIndex
  );
}
