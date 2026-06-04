import type { LayoutStep } from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import {
  recipeChildren,
  recipeIdOrThrow
} from "./recipes.js";
import type {
  CacheSelection,
  MutableRegionSchedule,
  WasmCacheOccurrence,
  WasmCacheOccurrenceBase,
  WasmCacheOccurrenceSource,
  WasmCacheRecipeOccurrence,
  WasmCacheSavedExprOccurrence,
  WasmCacheSaveExprOccurrence
} from "./types.js";

export function scheduleCacheOccurrences(input: Readonly<{
  layout: { regions: readonly { id: MutableRegionSchedule["region"]; steps: readonly LayoutStep[] }[] };
  recipes: ValuePlan["recipes"];
  selected: CacheSelection;
}>): readonly MutableRegionSchedule[] {
  const schedule: MutableRegionSchedule[] = [];
  const nextOccurrenceId = { value: 0 };

  for (const region of input.layout.regions) {
    const occurrences: WasmCacheOccurrence[] = [];

    region.steps.forEach((step, stepIndex) => {
      scheduleStep(step, stepIndex, occurrences, input.recipes, input.selected, nextOccurrenceId);
    });

    if (occurrences.length > 0) {
      schedule.push({
        region: region.id,
        occurrences
      });
    }
  }

  return schedule;
}

function scheduleStep(
  step: LayoutStep,
  stepIndex: number,
  occurrences: WasmCacheOccurrence[],
  recipes: ValuePlan["recipes"],
  selected: CacheSelection,
  nextOccurrenceId: { value: number }
): void {
  switch (step.kind) {
    case "definition":
    case "action":
      for (const input of step.inputs) {
        scheduleRecipe(input.recipe, Object.freeze({
          kind: "layout-use",
          use: input.id
        } satisfies WasmCacheOccurrenceSource), stepIndex, 0, occurrences, recipes, selected, nextOccurrenceId);
      }
      break;
    case "write-state":
      if (step.value !== undefined) {
        scheduleRecipe(step.value.recipe, Object.freeze({
          kind: "layout-use",
          use: step.value.id
        } satisfies WasmCacheOccurrenceSource), stepIndex, 0, occurrences, recipes, selected, nextOccurrenceId);
      }
      break;
    case "save-expr":
      scheduleSaveExpr(step, stepIndex, occurrences, recipes, selected, nextOccurrenceId);
      break;
    case "exit":
      break;
  }
}

function scheduleSaveExpr(
  step: Extract<LayoutStep, { kind: "save-expr" }>,
  stepIndex: number,
  occurrences: WasmCacheOccurrence[],
  recipes: ValuePlan["recipes"],
  selected: CacheSelection,
  nextOccurrenceId: { value: number }
): void {
  const source = Object.freeze({
    kind: "save-expr",
    saved: step.saved
  } satisfies WasmCacheOccurrenceSource);

  scheduleRecipeChildren(step.recipe, source, stepIndex, 0, occurrences, recipes, selected, nextOccurrenceId);

  const entry = selected.bySavedId.get(step.saved);

  if (entry !== undefined) {
    occurrences.push(Object.freeze({
      ...occurrenceBase(nextOccurrenceId, occurrences, entry.id, stepIndex),
      kind: "save-expr",
      saved: step.saved,
      recipe: step.recipe
    } satisfies WasmCacheSaveExprOccurrence));
  }
}

function scheduleRecipeChildren(
  recipe: ExprRecipe,
  source: WasmCacheOccurrenceSource,
  stepIndex: number,
  parentDepth: number,
  occurrences: WasmCacheOccurrence[],
  recipes: ValuePlan["recipes"],
  selected: CacheSelection,
  nextOccurrenceId: { value: number }
): void {
  for (const child of recipeChildren(recipe)) {
    scheduleRecipe(child, source, stepIndex, parentDepth + 1, occurrences, recipes, selected, nextOccurrenceId);
  }
}

function scheduleRecipe(
  recipe: ExprRecipe,
  source: WasmCacheOccurrenceSource,
  stepIndex: number,
  depth: number,
  occurrences: WasmCacheOccurrence[],
  recipes: ValuePlan["recipes"],
  selected: CacheSelection,
  nextOccurrenceId: { value: number }
): void {
  if (recipe.kind === "saved-expr") {
    const entry = selected.bySavedId.get(recipe.saved);

    if (entry !== undefined) {
      occurrences.push(Object.freeze({
        ...occurrenceBase(nextOccurrenceId, occurrences, entry.id, stepIndex),
        kind: "saved-expr",
        depth,
        source,
        saved: recipe.saved
      } satisfies WasmCacheSavedExprOccurrence));
    }

    return;
  }

  scheduleRecipeChildren(recipe, source, stepIndex, depth, occurrences, recipes, selected, nextOccurrenceId);

  const entry = selected.byRecipeId.get(recipeIdOrThrow(recipes, recipe));

  if (entry !== undefined) {
    occurrences.push(Object.freeze({
      ...occurrenceBase(nextOccurrenceId, occurrences, entry.id, stepIndex),
      kind: "recipe",
      depth,
      source,
      recipe
    } satisfies WasmCacheRecipeOccurrence));
  }
}

function occurrenceBase(
  nextOccurrenceId: { value: number },
  occurrences: readonly WasmCacheOccurrence[],
  entry: WasmCacheOccurrenceBase["entry"],
  step: number
): WasmCacheOccurrenceBase {
  const id = nextOccurrenceId.value as WasmCacheOccurrenceBase["id"];

  nextOccurrenceId.value += 1;
  return Object.freeze({
    id,
    index: occurrences.length,
    entry,
    step
  } satisfies WasmCacheOccurrenceBase);
}
