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
import type { ValueRef } from "#x86/ir/model/types.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt,
  type JitInstructionValueTimeline
} from "./value-timeline.js";

export type JitValueUseCount = Readonly<{
  value: JitValue;
  useCount: number;
}>;

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

type JitValueUse = Readonly<{
  value: JitValue;
  emittedCost: number;
  forceLegacyFlagSetInputCache: boolean;
  children: readonly JitValueUse[];
}>;

type JitValueEpochUses = Readonly<{
  consumerUsesByEpoch: readonly (readonly JitValueUse[])[];
  captureValuesByEpoch: readonly (readonly JitValue[])[];
}>;

type FlatJitValueUse = Readonly<{
  value: JitValue;
  emittedCost: number;
  forceLegacyFlagSetInputCache: boolean;
  ancestors: readonly JitValue[];
}>;

const localTeeCost = 1;
const localSetCost = 1;
const localGetCost = 1;

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
  const epochs: JitValueUse[][] = [];
  const captureValuesByEpoch: JitValue[][] = [];
  const producedDefinitionCaptures = producedValueKeysNeededByConsumers(instructions);
  let currentEpoch: JitValueUse[] = [];

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
): readonly JitValueUse[] {
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
      // Temporary until Step 5 converts flag exits to planned target/value stores.
      // The legacy flag-state emitter captures pending non-const inputs here, so
      // value-cache must retain those roots to avoid rematerializing the same
      // source before a following register writeback.
      return Object.values(op.inputs).flatMap((value) =>
        retainedValueUsesForValueRef(instruction, value, opIndex, {
          forceLegacyFlagSetInputCache: value.kind !== "const"
        })
      );
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
): readonly JitValueUse[] {
  return storage.kind === "mem"
    ? valueUsesForValue(instruction, storage.address, opIndex)
    : [];
}

function valueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  opIndex: number
): readonly JitValueUse[] {
  const jitValue = jitValueForValue(instruction, value, opIndex);

  return jitValue === undefined
    ? childValueUsesForValue(instruction, value, opIndex)
    : [jitValueUseTree(jitValue)];
}

function childValueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  opIndex: number
): readonly JitValueUse[] {
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

function retainedValueUsesForValueRef(
  instruction: JitExpressionValueCacheInstruction,
  value: ValueRef,
  opIndex: number,
  options: Readonly<{ forceLegacyFlagSetInputCache?: boolean }> = {}
): readonly JitValueUse[] {
  const jitValue = jitTimelineValueRefValueAt(instruction.valueTimeline, opIndex, value);

  return jitValue === undefined
    ? []
    : [jitValueUseTree(jitValue, options.forceLegacyFlagSetInputCache === true)];
}

function materializationJitValueUsesForOp(
  instruction: JitExpressionValueCacheInstruction,
  opIndex: number
): readonly JitValueUse[] {
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

      for (const use of flattenUses(valueUsesForOp(instruction, op, opIndex))) {
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

function jitValueUseTree(value: JitValue, forceLegacyFlagSetInputCache = false): JitValueUse {
  const simplified = simplifyJitValue(value);

  return {
    value: simplified,
    emittedCost: jitValueCost(simplified),
    forceLegacyFlagSetInputCache,
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

function selectEpochValues(uses: readonly JitValueUse[]): readonly JitValueUseCount[] {
  const flatUses = flattenUses(uses);
  const candidateValues = [...uniqueValues(flatUses.map((use) => use.value))]
    .sort((a, b) => jitValueCost(b) - jitValueCost(a));
  const selected: JitValueUseCount[] = [];

  for (const value of candidateValues) {
    const matchingUses = flatUses.filter((use) => jitValuesEqual(use.value, value));
    const forceSelected = shouldForceSelectValue(value);
    const usableUses = matchingUses.filter((use) =>
      forceSelected || !hasSelectedAncestor(use, selected)
    );

    if (shouldCacheValueForUses(value, usableUses)) {
      selected.push({
        value,
        useCount: usableUses.length
      });
    }
  }

  return selected;
}

function selectConsumerValuesByEpoch(
  usesByEpoch: readonly (readonly JitValueUse[])[]
): readonly (readonly JitValueUseCount[])[] {
  const selectedByEpoch = usesByEpoch.map(selectEpochValues);
  const globallySelected = selectEpochValues(usesByEpoch.flat());

  if (globallySelected.length === 0) {
    return selectedByEpoch;
  }

  return selectedByEpoch.map((epochSelected, epochIndex) => {
    const epochUses = flattenUses(usesByEpoch[epochIndex] ?? []);
    const selected = [...epochSelected];

    for (const globalEntry of globallySelected) {
      if (selected.some((entry) => jitValuesEqual(entry.value, globalEntry.value))) {
        continue;
      }

      const forceSelected = shouldForceSelectValue(globalEntry.value);
      const epochUseCount = epochUses.filter((use) =>
        jitValuesEqual(use.value, globalEntry.value) &&
          (forceSelected || !hasSelectedAncestor(use, selected))
      ).length;

      if (epochUseCount !== 0) {
        selected.push({ value: globalEntry.value, useCount: epochUseCount });
      }
    }

    return selected;
  });
}

function shouldCacheValueForUses(value: JitValue, uses: readonly FlatJitValueUse[]): boolean {
  if (uses.length === 0) {
    return false;
  }

  if (uses.some((use) => use.forceLegacyFlagSetInputCache)) {
    return true;
  }

  const firstEmittedCost = uses[0]!.emittedCost;
  const repeatedEmittedCost = uses.reduce((cost, use) => cost + use.emittedCost, 0);

  return shouldCacheValueWithCosts(value, uses.length, firstEmittedCost, repeatedEmittedCost);
}

function shouldCacheValueWithCosts(
  value: JitValue,
  useCount: number,
  firstInlineCost: number,
  repeatedInlineCost: number
): boolean {
  if (shouldForceSelectValue(value)) {
    return useCount > 0;
  }

  if (useCount <= 1 || firstInlineCost <= 1) {
    return false;
  }

  const cachedStackUseCost = firstInlineCost + localTeeCost + localGetCost * (useCount - 1);
  const materializedCost = firstInlineCost + localSetCost + localGetCost * useCount;

  return repeatedInlineCost > Math.min(cachedStackUseCost, materializedCost);
}

function shouldForceSelectValue(value: JitValue): boolean {
  return simplifyJitValue(value).kind === "produced";
}

function flattenUses(uses: readonly JitValueUse[]): readonly FlatJitValueUse[] {
  return uses.flatMap((use) => flattenUse(use));
}

function flattenUse(use: JitValueUse, ancestors: readonly JitValue[] = []): readonly FlatJitValueUse[] {
  const current = {
    value: use.value,
    emittedCost: use.emittedCost,
    forceLegacyFlagSetInputCache: use.forceLegacyFlagSetInputCache,
    ancestors
  };
  const childAncestors = [...ancestors, use.value];

  return [
    current,
    ...use.children.flatMap((child) => flattenUse(child, childAncestors))
  ];
}

function hasSelectedAncestor(
  use: FlatJitValueUse,
  selected: readonly JitValueUseCount[]
): boolean {
  return use.ancestors.some((ancestor) =>
    selected.some((entry) => jitValuesEqual(entry.value, ancestor))
  );
}

function uniqueValues(values: readonly JitValue[]): readonly JitValue[] {
  const unique: JitValue[] = [];

  for (const value of values) {
    if (!unique.some((entry) => jitValuesEqual(entry, value))) {
      unique.push(value);
    }
  }

  return unique;
}

function mergeSelectedUseCounts(
  selectedByEpoch: readonly (readonly JitValueUseCount[])[]
): readonly JitValueUseCount[] {
  const merged: JitValueUseCount[] = [];

  for (const selected of selectedByEpoch) {
    for (const entry of selected) {
      const existingIndex = merged.findIndex((candidate) =>
        jitValuesEqual(candidate.value, entry.value)
      );

      if (existingIndex === -1) {
        merged.push(entry);
      } else {
        const existing = merged[existingIndex]!;

        merged[existingIndex] = {
          value: existing.value,
          useCount: existing.useCount + entry.useCount
        };
      }
    }
  }

  return merged;
}
