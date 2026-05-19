import { valueCost } from "#backends/wasm/jit/ir/values/cost.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { EpochUsePlan } from "./epochs.js";
import type { ValueUse } from "./value-uses.js";

export type SelectedValue = Readonly<{
  value: JitValue;
  useCount: number;
}>;

export type EpochPlan = Readonly<{
  index: number;
  consumers: readonly SelectedValue[];
}>;

export type CachePlan = Readonly<{
  epochs: readonly EpochPlan[];
  selected: readonly SelectedValue[];
}>;

export type CacheSelectionPlan = Readonly<{
  consumers: readonly (readonly SelectedValue[])[];
  selected: readonly SelectedValue[];
}>;

const localTeeCost = 1;
const localSetCost = 1;
const localGetCost = 1;

export function selectCacheValues(
  epochUses: readonly (readonly ValueUse[])[],
  forcedValues: readonly JitValue[] = []
): CacheSelectionPlan {
  const consumers = selectConsumers(epochUses, forcedValues);
  const selected = mergeSelectedUseCounts(consumers);

  return {
    consumers,
    selected
  };
}

export function planCache(
  epochs: readonly EpochUsePlan[],
  forcedValues: readonly JitValue[] = []
): CachePlan {
  const selection = selectCacheValues(
    epochs.map((epoch) => epoch.uses),
    forcedValues
  );

  return {
    epochs: epochs.map((epoch, index) => ({
      index: epoch.index,
      consumers: selection.consumers[index] ?? []
    })),
    selected: selection.selected
  };
}

function selectConsumers(
  epochUses: readonly (readonly ValueUse[])[],
  forcedValues: readonly JitValue[]
): readonly (readonly SelectedValue[])[] {
  const epochSelections = epochUses.map((uses) => selectEpochValues(uses, forcedValues));
  const globallySelected = selectEpochValues(epochUses.flat(), forcedValues);

  if (globallySelected.length === 0) {
    return epochSelections;
  }

  return epochSelections.map((epochSelected, epochIndex) => {
    const uses = epochUses[epochIndex] ?? [];
    const selected = [...epochSelected];

    for (const globalEntry of globallySelected) {
      if (selected.some((entry) => valuesEqual(entry.value, globalEntry.value))) {
        continue;
      }

      const forceSelected = shouldForceSelectValue(globalEntry.value, forcedValues);
      const epochUseCount = uses.filter((use) =>
        valuesEqual(use.value, globalEntry.value) &&
          (forceSelected || !hasSelectedAncestor(use, selected, forcedValues))
      ).length;

      if (epochUseCount !== 0) {
        selected.push({ value: globalEntry.value, useCount: epochUseCount });
      }
    }

    return selected;
  });
}

function mergeSelectedUseCounts(
  epochSelections: readonly (readonly SelectedValue[])[]
): readonly SelectedValue[] {
  const merged: SelectedValue[] = [];

  for (const selected of epochSelections) {
    for (const entry of selected) {
      const existingIndex = merged.findIndex((candidate) =>
        valuesEqual(candidate.value, entry.value)
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
  uses: readonly ValueUse[],
  forcedValues: readonly JitValue[]
): readonly SelectedValue[] {
  const candidateValues = [...uniqueValues(uses.map((use) => use.value))]
    .sort((a, b) => valueCost(b) - valueCost(a));
  const selected: SelectedValue[] = [];

  for (const value of candidateValues) {
    const matchingUses = uses.filter((use) => valuesEqual(use.value, value));
    const forceSelected = shouldForceSelectValue(value, forcedValues);
    const usableUses = matchingUses.filter((use) =>
      forceSelected || !hasSelectedAncestor(use, selected, forcedValues)
    );

    if (shouldCacheValueForUses(value, usableUses, forcedValues)) {
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
  uses: readonly ValueUse[],
  forcedValues: readonly JitValue[]
): boolean {
  if (uses.length === 0) {
    return false;
  }

  const firstEmittedCost = valueCost(uses[0]!.value);
  const repeatedEmittedCost = uses.reduce((cost, use) => cost + valueCost(use.value), 0);

  return shouldCacheValueWithCosts(
    value,
    uses.length,
    firstEmittedCost,
    repeatedEmittedCost,
    forcedValues
  );
}

function shouldCacheValueWithCosts(
  value: JitValue,
  useCount: number,
  firstInlineCost: number,
  repeatedInlineCost: number,
  forcedValues: readonly JitValue[]
): boolean {
  if (shouldForceSelectValue(value, forcedValues)) {
    return useCount > 0;
  }

  if (useCount <= 1 || firstInlineCost <= 1) {
    return false;
  }

  const cachedStackUseCost = firstInlineCost + localTeeCost + localGetCost * (useCount - 1);
  const materializedCost = firstInlineCost + localSetCost + localGetCost * useCount;

  return repeatedInlineCost > Math.min(cachedStackUseCost, materializedCost);
}

function shouldForceSelectValue(value: JitValue, forcedValues: readonly JitValue[]): boolean {
  const simplified = simplifyValue(value);

  return simplified.kind === "loadResult" ||
    forcedValues.some((forced) => valuesEqual(simplified, simplifyValue(forced)));
}

function hasSelectedAncestor(
  use: ValueUse,
  selected: readonly SelectedValue[],
  forcedValues: readonly JitValue[]
): boolean {
  return use.ancestors.some((ancestor) =>
    selected.some((entry) =>
      !isForcedValue(entry.value, forcedValues) &&
        valuesEqual(entry.value, ancestor)
    )
  );
}

function isForcedValue(value: JitValue, forcedValues: readonly JitValue[]): boolean {
  const simplified = simplifyValue(value);

  return forcedValues.some((forced) => valuesEqual(simplified, simplifyValue(forced)));
}

function uniqueValues(values: readonly JitValue[]): readonly JitValue[] {
  const unique: JitValue[] = [];

  for (const value of values) {
    if (!unique.some((entry) => valuesEqual(entry, value))) {
      unique.push(value);
    }
  }

  return unique;
}
