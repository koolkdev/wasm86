import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  analyzeBarrierFacts,
  analyzeExpressionNeeds,
  analyzePlacementPlan,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildBlockLayout,
  buildTimelineGeometry,
  buildTimelineValueUseIndex,
  type BlockLayout,
  type ExprRecipe,
  type LayoutRegion,
  type LayoutStep,
  type SavedExpr,
  type ValuePlan
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import {
  planWasmCache,
  WasmCachePlanner,
  type WasmCacheEntry,
  type WasmCacheOccurrence,
  type WasmCachePlan
} from "#wasm/emit/values/cache/index.js";

test("Wasm cache plan creates a forced entry for every SavedExpr", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x11), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 }
  ], {
    resolver: dynamicResolver()
  });
  const saved = only(values.savedExprs);
  const plan = new WasmCachePlanner({ layout, values }).plan();
  const entry = forcedEntry(plan, saved);

  deepStrictEqual(entry.recipe, saved.recipe);
  deepStrictEqual(entry.reasons, [{ kind: "saved-expr", saved: saved.id }]);
  strictEqual(entry.uses.length, 1);
});

test("Wasm cache plan attaches same-point uses to forced save entries", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 }
  ], {
    resolver: dynamicResolver()
  });
  const saved = only(values.savedExprs);
  const main = layout.regions.find((region) => region.path.kind === "main")!;
  const saveIndex = main.steps.findIndex((step) => step.kind === "save-expr");
  const storeIndex = main.steps.findIndex((step) =>
    step.kind === "action" && step.site.action.kind === "dynamicRegisterStore"
  );
  const dynamicStore = main.steps[storeIndex] as Extract<LayoutStep, { kind: "action" }>;
  const samePointUse = dynamicStore.inputs.find((input) => input.use.role === "value")!;
  const laterSavedUse = only(main.steps.flatMap((step) =>
    step.kind === "action" && step.site.action.kind === "memoryStore"
      ? step.inputs.filter((input) => input.recipe.kind === "saved-expr")
      : []
  ));
  const plan = planWasmCache({ layout, values });
  const entry = forcedEntry(plan, saved);

  strictEqual(saveIndex >= 0, true);
  strictEqual(saveIndex < storeIndex, true);
  deepStrictEqual(dynamicStore.inputs.map((input) => input.recipe.kind), ["inline", "inline"]);
  strictEqual(samePointUse.recipe.kind, "inline");
  strictEqual(laterSavedUse.recipe.kind, "saved-expr");
  deepStrictEqual(entry.uses, [samePointUse.id, laterSavedUse.id]);
});

test("Wasm cache plan exposes nested pre-save child uses for forced save entries", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(4) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x11), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(0), accessWidth: 32 }
  ], {
    resolver: dynamicResolver()
  });
  const saved = only(values.savedExprs);
  const main = layout.regions.find((region) => region.path.kind === "main")!;
  const saveIndex = main.steps.findIndex((step) => step.kind === "save-expr");
  const memoryStores = main.steps.filter((step): step is Extract<LayoutStep, { kind: "action" }> =>
    step.kind === "action" && step.site.action.kind === "memoryStore"
  );
  const preSaveUse = only(memoryStores[0]!.inputs.filter((input) => input.use.role === "value"));
  const laterSavedUse = only(memoryStores[1]!.inputs.filter((input) => input.recipe.kind === "saved-expr"));
  const plan = planWasmCache({ layout, values });
  const entry = forcedEntry(plan, saved);
  const scheduled = entryOccurrences(regionOccurrences(plan, main), entry);

  const preSaveIndex = main.steps.indexOf(memoryStores[0]!);

  strictEqual(preSaveIndex >= 0, true);
  strictEqual(saveIndex > preSaveIndex, true);
  deepStrictEqual(preSaveUse.recipe, {
    kind: "inline",
    expr: exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(4))
  });
  deepStrictEqual(entry.uses, [preSaveUse.id, laterSavedUse.id]);
  deepStrictEqual(scheduled.map((event) => event.kind), ["recipe", "save-expr", "saved-expr"]);
  strictEqual(scheduled[0]!.kind, "recipe");
  strictEqual(scheduled[0]!.depth, 1);
  deepStrictEqual(scheduled[0]!.source, { kind: "layout-use", use: preSaveUse.id });
  strictEqual(scheduled[1]!.kind, "save-expr");
  strictEqual(scheduled[1]!.step, saveIndex);
  strictEqual(scheduled[2]!.kind, "saved-expr");
  deepStrictEqual(scheduled[2]!.source, { kind: "layout-use", use: laterSavedUse.id });
});

test("Wasm cache plan may choose repeated expressions without creating SavedExpr", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(1), accessWidth: 32 }
  ]);
  const plan = planWasmCache({ layout, values });
  const entry = only(plan.entries);

  strictEqual(values.savedExprs.length, 0);
  deepStrictEqual(entry.reasons.map((reason) => reason.kind), ["reuse"]);
  strictEqual(entry.uses.length, 2);
});

test("Wasm cache plan counts repeated expensive nested recipes for reuse", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "value.binary", type: "i32", operator: "xor", dst: v(2), a: v(1), b: c(2) },
    { op: "value.binary", type: "i32", operator: "or", dst: v(3), a: v(1), b: c(3) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(3), accessWidth: 32 }
  ]);
  const nestedAdd = inlineRecipe(exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1)));
  const plan = planWasmCache({ layout, values });
  const entry = entryForRecipe(plan, values, nestedAdd);

  deepStrictEqual(values.savedExprs, []);
  deepStrictEqual(entry?.recipe, nestedAdd);
  deepStrictEqual(entry?.reasons.map((reason) => reason.kind), ["reuse"]);
  strictEqual(entry?.uses.length, 2);
});

test("Wasm cache plan leaves cheap repeated nested recipes inline", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "xor", dst: v(1), a: v(0), b: c(2) },
    { op: "value.binary", type: "i32", operator: "or", dst: v(2), a: v(0), b: c(3) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(2), accessWidth: 32 }
  ]);
  const nestedInput = inlineRecipe(exprInput({ kind: "reg", reg: "eax" }));
  const plan = planWasmCache({ layout, values });

  deepStrictEqual(values.savedExprs, []);
  strictEqual(entryForRecipe(plan, values, nestedInput), undefined);
});

test("Wasm cache schedule keeps duplicate selected child occurrences distinct", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: v(0) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 }
  ]);
  const inputRecipe = inlineRecipe(exprInput({ kind: "reg", reg: "eax" }));
  const plan = planWasmCache({
    layout,
    values,
    costModel: {
      inlineCost: () => 10,
      cacheFromUseCost: 0,
      cacheFromSaveCost: 0,
      cachedUseCost: 0
    }
  });
  const entry = entryForRecipe(plan, values, inputRecipe) ?? fail("missing selected input recipe");
  const mainEvents = regionOccurrences(plan, mainRegion(layout));
  const events = entryOccurrences(mainEvents, entry);

  strictEqual(mainEvents.length, 2);
  deepStrictEqual(mainEvents.map((event) => event.index), [0, 1]);
  deepStrictEqual(events.map((event) => event.kind), ["recipe", "recipe"]);
  strictEqual(events[0]!.entry, events[1]!.entry);
  strictEqual(events[0]!.step, events[1]!.step);
  strictEqual(events[0]!.id === events[1]!.id, false);
  strictEqual(events[0]!.index === events[1]!.index, false);

  const first = events[0]!;
  const second = events[1]!;

  strictEqual(first.kind, "recipe");
  strictEqual(second.kind, "recipe");
  strictEqual(first.depth, second.depth);
  deepStrictEqual(first.source, second.source);
  deepStrictEqual(first.recipe, second.recipe);
});

test("Wasm cache plan leaves cheap repeated expressions inline", () => {
  const { layout, values } = analyzeBlock([
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
  ]);
  const plan = planWasmCache({ layout, values });

  strictEqual(values.savedExprs.length, 0);
  deepStrictEqual(plan.entries, []);
});

test("Wasm cache plan can attach saved-expr and reuse reasons to one entry", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "get", dst: v(2), source: { kind: "mem", address: v(1) }, accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(2), accessWidth: 32 }
  ]);
  const saved = only(values.savedExprs);
  const plan = planWasmCache({ layout, values });
  const entry = forcedEntry(plan, saved);
  const reuse = entry.reasons.find((reason) => reason.kind === "reuse");

  deepStrictEqual(entry.reasons.map((reason) => reason.kind), ["saved-expr", "reuse"]);
  strictEqual(reuse?.kind, "reuse");
  strictEqual(reuse.estimatedBenefit > 0, true);
  strictEqual(entry.uses.length, 2);
});

test("Wasm cache schedule keeps sequential address cache lifetimes non-overlapping", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "set", target: { kind: "mem", address: v(1) }, value: c(0x10), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: v(1) }, value: c(0x11), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c(2) },
    { op: "set", target: { kind: "mem", address: v(2) }, value: c(0x20), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: v(2) }, value: c(0x21), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(3), a: v(0), b: c(3) },
    { op: "set", target: { kind: "mem", address: v(3) }, value: c(0x30), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: v(3) }, value: c(0x31), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(4), a: v(0), b: c(4) },
    { op: "set", target: { kind: "mem", address: v(4) }, value: c(0x40), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: v(4) }, value: c(0x41), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(5), a: v(0), b: c(5) },
    { op: "set", target: { kind: "mem", address: v(5) }, value: c(0x50), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: v(5) }, value: c(0x51), accessWidth: 32 }
  ]);
  const plan = planWasmCache({ layout, values });
  const mainEvents = regionOccurrences(plan, mainRegion(layout));

  strictEqual(plan.entries.length, 5);
  deepStrictEqual(plan.entries.map((entry) => entry.uses.length), [2, 2, 2, 2, 2]);
  strictEqual(mainEvents.length, 10);
  strictEqual(maxConcurrentEntries(mainEvents), 1);
  strictEqual(mainEvents.every((event) =>
    event.kind === "recipe" &&
    event.source.kind === "layout-use" &&
    plan.entries.some((entry) => entry.id === event.entry)
  ), true);
});

test("Wasm cache schedule ends SavedExpr lifetime before later same-region work", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x11), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: c(2), b: c(1) },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1008) }, value: v(2), accessWidth: 32 }
  ], {
    resolver: dynamicResolver()
  });
  const saved = only(values.savedExprs);
  const plan = planWasmCache({ layout, values });
  const entry = forcedEntry(plan, saved);
  const mainEvents = regionOccurrences(plan, mainRegion(layout));
  const lastForcedIndex = lastEntryOccurrenceIndex(mainEvents, entry);
  const forcedEvents = entryOccurrences(mainEvents, entry);

  strictEqual(forcedEvents.at(-1)?.kind, "saved-expr");
  strictEqual(mainEvents.slice(lastForcedIndex + 1).some((event) => event.entry !== entry.id), true);
});

test("Wasm cache schedule keeps child-region occurrences separate from sibling work", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(1), accessWidth: 32 },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: c(0), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ecx" }, value: c(0), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c(2) },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1008) }, value: v(2), accessWidth: 32 },
    { op: "next" }
  ]);
  const plan = planWasmCache({ layout, values });
  const mainEvents = regionOccurrences(plan, mainRegion(layout));
  const edgeEvents = layout.regions
    .filter((region) => region.path.kind === "edge")
    .flatMap((region) => regionOccurrences(plan, region));
  const mainEntryIds = new Set(mainEvents.map((event) => event.entry));
  const edgeEntryIds = new Set(edgeEvents.map((event) => event.entry));
  const edgeOnlyEntryIds = [...edgeEntryIds].filter((entry) => !mainEntryIds.has(entry));
  const mainOnlyEntryIds = [...mainEntryIds].filter((entry) => !edgeEntryIds.has(entry));

  strictEqual(edgeOnlyEntryIds.length > 0, true);
  strictEqual(mainOnlyEntryIds.length > 0, true);
  strictEqual(edgeOnlyEntryIds.some((entry) => mainEntryIds.has(entry)), false);
  strictEqual(mainOnlyEntryIds.some((entry) => edgeEntryIds.has(entry)), false);
});

test("Wasm cache plan output has no concrete local operation fields", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(1), accessWidth: 32 }
  ]);
  const plan = planWasmCache({ layout, values });
  const entry = only(plan.entries);
  const reason = only(entry.reasons);
  const serialized = JSON.stringify(plan);

  deepStrictEqual(Object.keys(plan), ["entries", "schedule"]);
  deepStrictEqual(Object.keys(entry), ["id", "recipe", "reasons", "uses"]);
  deepStrictEqual(Object.keys(reason), ["kind", "estimatedBenefit"]);
  strictEqual(serialized.includes("local.get"), false);
  strictEqual(serialized.includes("local.set"), false);
  strictEqual(serialized.includes("local.tee"), false);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  layout: BlockLayout;
  values: ValuePlan;
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const timelineUses = buildTimelineValueUseIndex({ walked, geometry });
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ timelineUses, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs: needs.needs, geometry, facts });
  const stateWrites = analyzeStateWrites({
    obligations,
    valueNeeds: needs.valueNeedByObligation,
    values
  });
  const placement = analyzePlacementPlan({ geometry, facts, values, stateWrites });

  return {
    values,
    layout: buildBlockLayout({
      walked,
      geometry,
      timelineUses,
      timelineNeedByUse: needs.timelineNeedByUse,
      values,
      stateWrites,
      placement
    })
  };
}

function mainRegion(layout: BlockLayout): LayoutRegion {
  return layout.regions.find((region) => region.path.kind === "main")!;
}

function regionOccurrences(plan: WasmCachePlan, region: LayoutRegion): readonly WasmCacheOccurrence[] {
  return plan.schedule.find((schedule) => schedule.region === region.id)?.occurrences ?? [];
}

function entryOccurrences(
  occurrences: readonly WasmCacheOccurrence[],
  entry: WasmCacheEntry
): readonly WasmCacheOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.entry === entry.id);
}

function maxConcurrentEntries(occurrences: readonly WasmCacheOccurrence[]): number {
  const lastByEntry = new Map<WasmCacheEntry["id"], number>();
  const live = new Set<WasmCacheEntry["id"]>();
  let max = 0;

  occurrences.forEach((occurrence, index) => {
    lastByEntry.set(occurrence.entry, index);
  });

  occurrences.forEach((occurrence, index) => {
    live.add(occurrence.entry);
    max = Math.max(max, live.size);

    if (lastByEntry.get(occurrence.entry) === index) {
      live.delete(occurrence.entry);
    }
  });

  return max;
}

function lastEntryOccurrenceIndex(occurrences: readonly WasmCacheOccurrence[], entry: WasmCacheEntry): number {
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    if (occurrences[index]!.entry === entry.id) {
      return index;
    }
  }

  return fail(`missing schedule occurrence for cache entry ${entry.id}`);
}

function forcedEntry(plan: WasmCachePlan, saved: SavedExpr): WasmCacheEntry {
  return plan.entries.find((entry) =>
    entry.reasons.some((reason) => reason.kind === "saved-expr" && reason.saved === saved.id)
  ) ?? fail(`missing forced entry for saved expression ${saved.id}`);
}

function entryForRecipe(
  plan: WasmCachePlan,
  values: ValuePlan,
  recipe: ExprRecipe
): WasmCacheEntry | undefined {
  const recipeId = values.recipes.recipeId(recipe);

  return recipeId === undefined
    ? undefined
    : plan.entries.find((entry) => values.recipes.recipeId(entry.recipe) === recipeId);
}

function inlineRecipe(expr: ExprRef): ExprRecipe {
  return Object.freeze({ kind: "inline", expr } satisfies ExprRecipe);
}

function only<TValue>(values: readonly TValue[]): TValue {
  strictEqual(values.length, 1);
  return values[0]!;
}

function fail(message: string): never {
  throw new Error(message);
}

function dynamicResolver(): BindingResolver {
  return new BindingResolver({
    operands: [dynamicRegBinding(exprConst(3), 32)]
  });
}

function v(value: number): VarRef {
  return { kind: "var", id: value };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
