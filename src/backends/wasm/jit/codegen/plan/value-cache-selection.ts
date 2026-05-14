import {
  jitValueCost,
  jitValuesEqual,
  simplifyJitValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";

export type JitValueUseCount = Readonly<{
  value: JitValue;
  useCount: number;
}>;

export type JitValueCacheSelectionPlan = Readonly<{
  consumers: readonly (readonly JitValueUseCount[])[];
  useCounts: readonly JitValueUseCount[];
}>;

export type JitValueSelectionUse = Readonly<{
  value: JitValue;
  emittedCost: number;
  ancestors: readonly JitValue[];
}>;

const localTeeCost = 1;
const localSetCost = 1;
const localGetCost = 1;

export function planJitValueCacheSelection(
  epochUses: readonly (readonly JitValueSelectionUse[])[]
): JitValueCacheSelectionPlan {
  const consumers = selectConsumers(epochUses);
  const useCounts = mergeSelectedUseCounts(consumers);

  return {
    consumers,
    useCounts
  };
}

function selectConsumers(
  epochUses: readonly (readonly JitValueSelectionUse[])[]
): readonly (readonly JitValueUseCount[])[] {
  const epochSelections = epochUses.map(selectEpochValues);
  const globallySelected = selectEpochValues(epochUses.flat());

  if (globallySelected.length === 0) {
    return epochSelections;
  }

  return epochSelections.map((epochSelected, epochIndex) => {
    const uses = epochUses[epochIndex] ?? [];
    const selected = [...epochSelected];

    for (const globalEntry of globallySelected) {
      if (selected.some((entry) => jitValuesEqual(entry.value, globalEntry.value))) {
        continue;
      }

      const forceSelected = shouldForceSelectValue(globalEntry.value);
      const epochUseCount = uses.filter((use) =>
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

function mergeSelectedUseCounts(
  epochSelections: readonly (readonly JitValueUseCount[])[]
): readonly JitValueUseCount[] {
  const merged: JitValueUseCount[] = [];

  for (const selected of epochSelections) {
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

function selectEpochValues(
  uses: readonly JitValueSelectionUse[]
): readonly JitValueUseCount[] {
  const candidateValues = [...uniqueValues(uses.map((use) => use.value))]
    .sort((a, b) => jitValueCost(b) - jitValueCost(a));
  const selected: JitValueUseCount[] = [];

  for (const value of candidateValues) {
    const matchingUses = uses.filter((use) => jitValuesEqual(use.value, value));
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

function shouldCacheValueForUses(
  value: JitValue,
  uses: readonly JitValueSelectionUse[]
): boolean {
  if (uses.length === 0) {
    return false;
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

function hasSelectedAncestor(
  use: JitValueSelectionUse,
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
