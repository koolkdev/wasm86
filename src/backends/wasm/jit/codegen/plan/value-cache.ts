import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import {
  jitValueCost,
  jitValueForEffectiveAddress,
  jitValueForStorage,
  jitValuesEqual,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth, Reg32 } from "#x86/isa/types.js";
import { jitInstructionWrittenReg } from "./operand-analysis.js";

export type JitValueUseCount = Readonly<{
  value: JitValue;
  useCount: number;
}>;

export type JitExpressionValueCachePlan = Readonly<{
  instructionPlans: readonly JitInstructionValueCachePlan[];
  selectedValuesByEpoch: readonly (readonly JitValueUseCount[])[];
  selectedUseCounts: readonly JitValueUseCount[];
}>;

export type JitExpressionValueCacheInstruction = Readonly<{
  operands: readonly JitOperandBinding[];
  materializedValueExpressionUseIndexes?: ReadonlySet<number>;
}>;

export type JitInstructionValueCachePlan = JitExpressionValueCacheInstruction & Readonly<{
  expressionValues: ReadonlyMap<IrValueExpr, JitValue>;
  valueRefValues: ReadonlyMap<number, JitValue>;
}>;

export type JitExpressionValueCachePlanInput = JitExpressionValueCacheInstruction & Readonly<{
  expressionBlock: IrExprBlock;
}>;

type JitValueUse = Readonly<{
  value: JitValue;
  children: readonly JitValueUse[];
}>;

type FlatJitValueUse = Readonly<{
  value: JitValue;
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
  const selectedValuesByEpoch = epochUses.map(selectEpochValues);
  const selectedUseCounts = mergeSelectedUseCounts(selectedValuesByEpoch);

  return selectedUseCounts.length === 0
    ? undefined
    : {
        instructionPlans,
        selectedValuesByEpoch,
        selectedUseCounts
      };
}

export function shouldCacheValue(value: JitValue, useCount: number): boolean {
  const inlineCost = jitValueCost(value);

  if (useCount <= 1 || inlineCost <= 1) {
    return false;
  }

  const repeatedInlineCost = inlineCost * useCount;
  const cachedStackUseCost = inlineCost + localTeeCost + localGetCost * (useCount - 1);
  const materializedCost = inlineCost + localSetCost + localGetCost * useCount;

  return repeatedInlineCost > Math.min(cachedStackUseCost, materializedCost);
}

function expressionValueUseEpochs(
  instructions: readonly JitExpressionValueCachePlanInput[],
  instructionPlans: JitInstructionValueCachePlan[]
): readonly (readonly JitValueUse[])[] {
  const epochs: JitValueUse[][] = [];
  let currentEpoch: JitValueUse[] = [];

  for (const instruction of instructions) {
    const state = valueUseInstructionState();

    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
      }

      currentEpoch.push(...valueUsesForOp(instruction, op, opIndex, state));

      if (opWriteReg(instruction, op) !== undefined) {
        epochs.push(currentEpoch);
        currentEpoch = [];
      }
    }

    instructionPlans.push({
      operands: instruction.operands,
      ...(instruction.materializedValueExpressionUseIndexes === undefined
        ? {}
        : { materializedValueExpressionUseIndexes: instruction.materializedValueExpressionUseIndexes }),
      expressionValues: state.expressionJitValues,
      valueRefValues: state.valueRefJitValues
    });
  }

  epochs.push(currentEpoch);
  return epochs;
}

type JitValueUseInstructionState = Readonly<{
  expressionJitValues: Map<IrValueExpr, JitValue>;
  valueRefJitValues: Map<number, JitValue>;
}>;

function valueUseInstructionState(): JitValueUseInstructionState {
  return {
    expressionJitValues: new Map(),
    valueRefJitValues: new Map()
  };
}

function valueUsesForOp(
  instruction: JitExpressionValueCacheInstruction,
  op: IrExprOp,
  opIndex: number,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  switch (op.op) {
    case "let32": {
      const jitValue = jitValueForExpression(instruction, op.value, state);

      if (jitValue !== undefined) {
        state.valueRefJitValues.set(op.dst.id, jitValue);
      }

      return [];
    }
    case "set": {
      const expressionUses = [
        ...valueUsesForStorage(instruction, op.target, state),
        ...(op.role === "registerMaterialization" ? [] : valueUsesForValue(instruction, op.value, state))
      ];
      const retainedUses = op.role === "registerMaterialization"
        ? [
            ...retainedValueUsesForValue(instruction, op.value, state),
            ...materializedValueUsesForSet(instruction, opIndex, op, state)
          ]
        : [];

      return [...expressionUses, ...retainedUses];
    }
    case "set.if":
      return [
        ...valueUsesForValue(instruction, op.condition, state),
        ...valueUsesForValue(instruction, op.value, state)
      ];
    case "flags.set":
      return Object.values(op.inputs).flatMap((value) =>
        retainedValueUsesForValueRef(value, state)
      );
    case "jump":
      return valueUsesForValue(instruction, op.target, state);
    case "conditionalJump":
      return [
        ...valueUsesForValue(instruction, op.condition, state),
        ...valueUsesForValue(instruction, op.taken, state),
        ...valueUsesForValue(instruction, op.notTaken, state)
      ];
    case "hostTrap":
      return valueUsesForValue(instruction, op.vector, state);
    case "flags.materialize":
    case "flags.boundary":
    case "next":
      return [];
  }
}

function valueUsesForStorage(
  instruction: JitExpressionValueCacheInstruction,
  storage: IrStorageExpr,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  return storage.kind === "mem"
    ? valueUsesForValue(instruction, storage.address, state)
    : [];
}

function valueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  const children = childValueUsesForValue(instruction, value, state);
  const jitValue = jitValueForExpression(instruction, value, state);

  return jitValue === undefined
    ? children
    : [{ value: jitValue, children }];
}

function childValueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  switch (value.kind) {
    case "source":
      return valueUsesForStorage(instruction, value.source, state);
    case "value.binary":
      return [
        ...valueUsesForValue(instruction, value.a, state),
        ...valueUsesForValue(instruction, value.b, state)
      ];
    case "value.unary":
      return valueUsesForValue(instruction, value.value, state);
    case "value.select":
      return [
        ...valueUsesForValue(instruction, value.condition, state),
        ...valueUsesForValue(instruction, value.whenTrue, state),
        ...valueUsesForValue(instruction, value.whenFalse, state)
      ];
    case "flagProducer.condition":
      return Object.values(value.inputs).flatMap((input) =>
        valueUsesForValueRef(input, state)
      );
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "aluFlags.condition":
      return [];
  }
}

function valueUsesForValueRef(
  value: ValueRef,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  switch (value.kind) {
    case "const": {
      const jitValue = { kind: "const", type: value.type, value: value.value } as const satisfies JitValue;

      state.expressionJitValues.set(value, jitValue);
      return [{ value: jitValue, children: [] }];
    }
    case "var":
      return [];
    case "nextEip":
      return [];
  }
}

function retainedValueUsesForValue(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  const jitValue = jitValueForExpression(instruction, value, state) ??
    retainedJitValueForValueExpr(value, state);

  return jitValue === undefined
    ? []
    : [{ value: jitValue, children: [] }];
}

function retainedJitValueForValueExpr(
  value: IrValueExpr,
  state: JitValueUseInstructionState
): JitValue | undefined {
  switch (value.kind) {
    case "const":
    case "var":
    case "nextEip":
      return retainedJitValueForValueRef(value, state);
    default:
      return undefined;
  }
}

function retainedValueUsesForValueRef(
  value: ValueRef,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  const jitValue = retainedJitValueForValueRef(value, state);

  return jitValue === undefined
    ? []
    : [{ value: jitValue, children: [] }];
}

function retainedJitValueForValueRef(
  value: ValueRef,
  state: JitValueUseInstructionState
): JitValue | undefined {
  switch (value.kind) {
    case "const": {
      const jitValue = { kind: "const", type: value.type, value: value.value } as const satisfies JitValue;

      state.expressionJitValues.set(value, jitValue);
      return jitValue;
    }
    case "var":
      return state.valueRefJitValues.get(value.id);
    case "nextEip":
      return undefined;
  }
}

function materializedValueUsesForSet(
  instruction: JitExpressionValueCacheInstruction,
  opIndex: number,
  op: Extract<IrExprOp, { op: "set" }>,
  state: JitValueUseInstructionState
): readonly JitValueUse[] {
  if (
    op.role !== "registerMaterialization" ||
    instruction.materializedValueExpressionUseIndexes?.has(opIndex) !== true
  ) {
    return [];
  }

  return retainedValueUsesForValue(instruction, op.value, state);
}

function selectEpochValues(uses: readonly JitValueUse[]): readonly JitValueUseCount[] {
  const flatUses = flattenUses(uses);
  const candidateValues = [...uniqueValues(flatUses.map((use) => use.value))]
    .sort((a, b) => jitValueCost(b) - jitValueCost(a));
  const selected: JitValueUseCount[] = [];

  for (const value of candidateValues) {
    const usableUseCount = flatUses.filter((use) =>
      jitValuesEqual(use.value, value) && !hasSelectedAncestor(use, selected)
    ).length;

    if (shouldCacheValue(value, usableUseCount)) {
      selected.push({ value, useCount: usableUseCount });
    }
  }

  return selected;
}

function flattenUses(uses: readonly JitValueUse[]): readonly FlatJitValueUse[] {
  return uses.flatMap((use) => flattenUse(use));
}

function flattenUse(use: JitValueUse, ancestors: readonly JitValue[] = []): readonly FlatJitValueUse[] {
  const current = { value: use.value, ancestors };
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

function jitValueForExpression(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  state?: JitValueUseInstructionState
): JitValue | undefined {
  const jitValue = jitValueForExpressionUntracked(instruction, value, state);

  if (jitValue !== undefined) {
    state?.expressionJitValues.set(value, jitValue);
  }

  return jitValue;
}

function jitValueForExpressionUntracked(
  instruction: JitExpressionValueCacheInstruction,
  value: IrValueExpr,
  state?: JitValueUseInstructionState
): JitValue | undefined {
  switch (value.kind) {
    case "var":
      return undefined;
    case "const":
      return { kind: "const", type: value.type, value: value.value };
    case "source":
      return jitValueForStorageExpr(instruction, value.source, value.accessWidth, value.signed === true);
    case "address":
      return jitValueForEffectiveAddress(value.operand, instruction.operands, new Map());
    case "value.binary": {
      const a = jitValueForExpression(instruction, value.a, state);
      const b = jitValueForExpression(instruction, value.b, state);

      return a === undefined || b === undefined
        ? undefined
        : { kind: value.kind, type: value.type, operator: value.operator, a, b };
    }
    case "value.unary": {
      const inner = jitValueForExpression(instruction, value.value, state);

      return inner === undefined
        ? undefined
        : { kind: value.kind, type: value.type, operator: value.operator, value: inner };
    }
    case "value.select": {
      const condition = jitValueForExpression(instruction, value.condition, state);
      const whenTrue = jitValueForExpression(instruction, value.whenTrue, state);
      const whenFalse = jitValueForExpression(instruction, value.whenFalse, state);

      return condition === undefined || whenTrue === undefined || whenFalse === undefined
        ? undefined
        : { kind: value.kind, type: value.type, condition, whenTrue, whenFalse };
    }
    case "nextEip":
    case "aluFlags.condition":
    case "flagProducer.condition":
      return undefined;
  }
}

function jitValueForStorageExpr(
  instruction: JitExpressionValueCacheInstruction,
  storage: IrStorageExpr,
  accessWidth: OperandWidth,
  signed: boolean
): JitValue | undefined {
  switch (storage.kind) {
    case "reg":
    case "operand":
      return jitValueForStorage(storage, instruction.operands, new Map(), accessWidth, signed);
    case "mem":
      return undefined;
  }
}

function opWriteReg(
  instruction: JitExpressionValueCacheInstruction,
  op: IrExprOp
): Reg32 | undefined {
  switch (op.op) {
    case "set":
    case "set.if":
      return jitInstructionWrittenReg(instruction, op.target, op.accessWidth);
    default:
      return undefined;
  }
}
