import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type {
  LayoutRegion,
  LayoutRegionId,
  LayoutValueUseId
} from "#ir/block/planning/layout/index.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  RecipeRegistry,
  SavedExprId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCacheOccurrence,
  WasmCacheOccurrenceId,
  WasmCacheOccurrenceSource,
  WasmCachePlan,
  WasmCacheReason
} from "#wasm/emit/cache/plan/index.js";
import {
  createWasmValueCache,
  type WasmValueCache
} from "#wasm/emit/cache/locals/index.js";

test("Wasm value cache emits local.tee for first selected use and local.get for later use", () => {
  const main = region(0);
  const recipe = inlineInputRecipe("eax");
  const useA = useId(10);
  const useB = useId(11);
  const plan = cachePlan([cacheEntry(0, recipe)], [
    regionSchedule(main, [
      recipeOccurrence(0, 0, 0, recipe, sourceUse(useA)),
      recipeOccurrence(1, 1, 0, recipe, sourceUse(useB))
    ])
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitUse({ id: useA, recipe }, inline(body, "first"));
  cache.emitUse({ id: useB, recipe }, inline(body, "second"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache leaves unselected uses inline", () => {
  const main = region(0);
  const recipe = inlineInputRecipe("eax");
  const use = useId(10);
  const { body, cache, scratch } = createFixture(cachePlan([], []), [recipe]);

  cache.enterRegion(main);
  cache.emitUse({ id: use, recipe }, inline(body, "unselected"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "unselected" }
  ]);
  scratch.assertClear();
});

test("Wasm value cache rejects leaving a region with unconsumed selected occurrences before freeing locals", () => {
  const main = region(0);
  const recipe = inlineInputRecipe("eax");
  const useA = useId(12);
  const useB = useId(13);
  const plan = cachePlan([cacheEntry(0, recipe)], [
    regionSchedule(main, [
      recipeOccurrence(0, 0, 0, recipe, sourceUse(useA)),
      recipeOccurrence(1, 1, 0, recipe, sourceUse(useB))
    ])
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitUse({ id: useA, recipe }, inline(body, "first"));

  throws(
    () => cache.leaveRegion(main),
    /cannot leave Wasm cache region 0; unconsumed selected occurrence recipe#1/
  );
  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 }
  ]);

  cache.emitUse({ id: useB, recipe }, inline(body, "second"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache releases saved expression local after last saved-expr use", () => {
  const main = region(0);
  const saved = savedId(0);
  const savedRecipe = inlineInputRecipe("eax");
  const laterRecipe = inlineRecipe(exprBinary("add", exprConst(2), exprConst(1)));
  const savedUse = useId(20);
  const laterUseA = useId(21);
  const laterUseB = useId(22);
  const plan = cachePlan([
    cacheEntry(0, savedRecipe, [{ kind: "saved-expr", saved }]),
    cacheEntry(1, laterRecipe)
  ], [
    regionSchedule(main, [
      saveExprOccurrence(0, 0, 0, saved, savedRecipe),
      savedExprOccurrence(1, 1, 0, saved, sourceUse(savedUse)),
      recipeOccurrence(2, 2, 1, laterRecipe, sourceUse(laterUseA)),
      recipeOccurrence(3, 3, 1, laterRecipe, sourceUse(laterUseB))
    ])
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.ensureSaved(saved, savedRecipe, inline(body, "save"));
  cache.emitUse({ id: savedUse, recipe: savedExprRecipe(saved) }, inline(body, "saved-use"));
  cache.emitUse({ id: laterUseA, recipe: laterRecipe }, inline(body, "later-first"));
  cache.emitUse({ id: laterUseB, recipe: laterRecipe }, inline(body, "later-second"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "save" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 },
    { kind: "inline", label: "later-first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache consumes nested selected child before later save-expr", () => {
  const main = region(0);
  const saved = savedId(0);
  const savedRecipe = inlineInputRecipe("eax");
  const topUse = useId(30);
  const savedUse = useId(31);
  const source = sourceUse(topUse);
  const plan = cachePlan([cacheEntry(0, savedRecipe, [{ kind: "saved-expr", saved }])], [
    regionSchedule(main, [
      recipeOccurrence(0, 0, 0, savedRecipe, source, 1),
      saveExprOccurrence(1, 1, 0, saved, savedRecipe),
      savedExprOccurrence(2, 2, 0, saved, sourceUse(savedUse))
    ])
  ]);

  {
    const { cache } = createFixture(plan);

    cache.enterRegion(main);
    throws(
      () => cache.ensureSaved(saved, savedRecipe, failInline),
      /expected Wasm cache save-expr occurrence.*found recipe#0/
    );
  }

  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitRecipe(savedRecipe, source, inline(body, "nested-child"));
  cache.ensureSaved(saved, savedRecipe, inline(body, "save-should-not-run"));
  cache.emitUse({ id: savedUse, recipe: savedExprRecipe(saved) }, inline(body, "saved-use"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "nested-child" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache reuses locals for sequential cached values", () => {
  const main = region(0);
  const entries: WasmCacheEntry[] = [];
  const occurrences: WasmCacheOccurrence[] = [];
  const uses: LayoutValueUseId[] = [];
  const recipes: ExprRecipe[] = [];

  for (let index = 0; index < 8; index += 1) {
    const recipe = inlineRecipe(exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(index + 1)));
    const firstUse = useId(100 + index * 2);
    const secondUse = useId(101 + index * 2);

    recipes.push(recipe);
    uses.push(firstUse, secondUse);
    entries.push(cacheEntry(index, recipe));
    occurrences.push(
      recipeOccurrence(index * 2, index * 2, index, recipe, sourceUse(firstUse)),
      recipeOccurrence(index * 2 + 1, index * 2 + 1, index, recipe, sourceUse(secondUse))
    );
  }

  const { body, cache, scratch } = createFixture(cachePlan(entries, [regionSchedule(main, occurrences)]), recipes);

  cache.enterRegion(main);

  recipes.forEach((recipe, index) => {
    cache.emitUse({ id: uses[index * 2]!, recipe }, inline(body, `first-${index}`));
    cache.emitUse({ id: uses[index * 2 + 1]!, recipe }, inline(body, `second-${index}`));
  });

  cache.leaveRegion(main);

  const allocatedLocals = body.ops
    .filter((op): op is Extract<RecordedOp, { kind: "alloc" }> => op.kind === "alloc")
    .map((op) => op.local);
  const teeLocals = body.ops
    .filter((op): op is Extract<RecordedOp, { kind: "tee" }> => op.kind === "tee")
    .map((op) => op.local);

  deepStrictEqual([...new Set(allocatedLocals)], [0]);
  deepStrictEqual([...new Set(teeLocals)], [0]);
  strictEqual(teeLocals.length, 8);
  scratch.assertClear();
});

test("Wasm value cache keeps parent locals visible to child but not child locals visible to sibling", () => {
  const main = region(0);
  const child = region(1, edgePath(1));
  const sibling = region(2, edgePath(2));
  const parentRecipe = inlineInputRecipe("eax");
  const branchRecipe = inlineInputRecipe("ebx");
  const mainUse = useId(200);
  const childParentUse = useId(201);
  const childBranchUse = useId(202);
  const siblingBranchUse = useId(203);
  const plan = cachePlan([
    cacheEntry(0, parentRecipe),
    cacheEntry(1, branchRecipe)
  ], [
    regionSchedule(main, [
      recipeOccurrence(0, 0, 0, parentRecipe, sourceUse(mainUse))
    ]),
    regionSchedule(child, [
      recipeOccurrence(1, 0, 0, parentRecipe, sourceUse(childParentUse)),
      recipeOccurrence(2, 1, 1, branchRecipe, sourceUse(childBranchUse))
    ]),
    regionSchedule(sibling, [
      recipeOccurrence(3, 0, 1, branchRecipe, sourceUse(siblingBranchUse))
    ])
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitUse({ id: mainUse, recipe: parentRecipe }, inline(body, "parent-main"));

  cache.enterRegion(child);
  cache.emitUse({ id: childParentUse, recipe: parentRecipe }, inline(body, "parent-child"));
  cache.emitUse({ id: childBranchUse, recipe: branchRecipe }, inline(body, "branch-child"));
  cache.leaveRegion(child);

  cache.enterRegion(sibling);
  cache.emitUse({ id: siblingBranchUse, recipe: branchRecipe }, inline(body, "branch-sibling"));
  cache.leaveRegion(sibling);

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "parent-main" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 },
    { kind: "inline", label: "branch-child" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 },
    { kind: "inline", label: "branch-sibling" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache keeps child-owned locals for nested child scheduled uses", () => {
  const main = region(0);
  const child = region(1, edgePath(1));
  const nested = region(2, edgePath(2));
  const recipe = inlineInputRecipe("eax");
  const childUse = useId(210);
  const nestedUse = useId(211);
  const plan = cachePlan([cacheEntry(0, recipe)], [
    regionSchedule(child, [
      recipeOccurrence(0, 0, 0, recipe, sourceUse(childUse))
    ]),
    regionSchedule(nested, [
      recipeOccurrence(1, 0, 0, recipe, sourceUse(nestedUse))
    ])
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.enterRegion(child);
  cache.emitUse({ id: childUse, recipe }, inline(body, "child"));
  cache.enterRegion(nested);
  cache.emitUse({ id: nestedUse, recipe }, inline(body, "nested-should-not-run"));
  cache.leaveRegion(nested);
  cache.leaveRegion(child);
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "child" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

type RecordedOp =
  | Readonly<{ kind: "inline"; label: string }>
  | Readonly<{ kind: "alloc"; local: number; type: WasmValueType }>
  | Readonly<{ kind: "free"; local: number }>
  | Readonly<{ kind: "get"; local: number }>
  | Readonly<{ kind: "set"; local: number }>
  | Readonly<{ kind: "tee"; local: number }>;

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly ops: RecordedOp[] = [];

  override localGet(index: number): this {
    this.ops.push({ kind: "get", local: index });
    return this;
  }

  override localSet(index: number): this {
    this.ops.push({ kind: "set", local: index });
    return this;
  }

  override localTee(index: number): this {
    this.ops.push({ kind: "tee", local: index });
    return this;
  }
}

class RecordingScratch extends WasmLocalScratchAllocator {
  readonly #ops: RecordedOp[];

  constructor(body: RecordingBody) {
    super(body);
    this.#ops = body.ops;
  }

  override allocLocal(type: WasmValueType): number {
    const local = super.allocLocal(type);

    this.#ops.push({ kind: "alloc", local, type });
    return local;
  }

  override freeLocal(index: number): void {
    super.freeLocal(index);
    this.#ops.push({ kind: "free", local: index });
  }
}

function createFixture(
  plan: WasmCachePlan,
  extraRecipes: readonly ExprRecipe[] = []
): Readonly<{
  body: RecordingBody;
  cache: WasmValueCache;
  scratch: RecordingScratch;
}> {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const recipes = plan.entries.map((entry) => entry.recipe);

  return {
    body,
    scratch,
    cache: createWasmValueCache({
      plan,
      values: recipeValues([...recipes, ...extraRecipes]),
      body,
      scratch
    })
  };
}

function inline(body: RecordingBody, label: string): () => WasmValueType {
  return () => {
    body.ops.push({ kind: "inline", label });
    return wasmValueType.i32;
  };
}

function failInline(): never {
  throw new Error("inline emitter should not run");
}

function cachePlan(
  entries: readonly WasmCacheEntry[],
  schedule: readonly WasmCachePlan["schedule"][number][]
): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze([...entries]),
    schedule: Object.freeze([...schedule])
  } satisfies WasmCachePlan);
}

function cacheEntry(
  id: number,
  recipe: ExprRecipe,
  reasons: readonly WasmCacheReason[] = []
): WasmCacheEntry {
  return Object.freeze({
    id: id as WasmCacheEntryId,
    recipe,
    reasons: Object.freeze([...reasons]),
    uses: Object.freeze([])
  } satisfies WasmCacheEntry);
}

function regionSchedule(
  region: LayoutRegion,
  occurrences: readonly WasmCacheOccurrence[]
): WasmCachePlan["schedule"][number] {
  return Object.freeze({
    region: region.id,
    occurrences: Object.freeze([...occurrences])
  });
}

function recipeOccurrence(
  id: number,
  index: number,
  entry: number,
  recipe: ExprRecipe,
  source: WasmCacheOccurrenceSource,
  depth = 0
): WasmCacheOccurrence {
  return Object.freeze({
    id: id as WasmCacheOccurrenceId,
    index,
    entry: entry as WasmCacheEntryId,
    step: index,
    kind: "recipe",
    depth,
    source,
    recipe
  });
}

function saveExprOccurrence(
  id: number,
  index: number,
  entry: number,
  saved: SavedExprId,
  recipe: ExprRecipe
): WasmCacheOccurrence {
  return Object.freeze({
    id: id as WasmCacheOccurrenceId,
    index,
    entry: entry as WasmCacheEntryId,
    step: index,
    kind: "save-expr",
    saved,
    recipe
  });
}

function savedExprOccurrence(
  id: number,
  index: number,
  entry: number,
  saved: SavedExprId,
  source: WasmCacheOccurrenceSource
): WasmCacheOccurrence {
  return Object.freeze({
    id: id as WasmCacheOccurrenceId,
    index,
    entry: entry as WasmCacheEntryId,
    step: index,
    kind: "saved-expr",
    depth: 0,
    source,
    saved
  });
}

function recipeValues(recipes: readonly ExprRecipe[]): Pick<ValuePlan, "recipes"> {
  const recipeList: ExprRecipe[] = [];
  const idByKey = new Map<string, ExprRecipeId>();

  for (const recipe of recipes) {
    const key = JSON.stringify(recipe);

    if (idByKey.has(key)) {
      continue;
    }

    idByKey.set(key, recipeList.length as ExprRecipeId);
    recipeList.push(recipe);
  }

  return {
    recipes: Object.freeze({
      recipeForNeed: () => undefined,
      recipeIdForNeed: () => undefined,
      recipeId: (recipe) => idByKey.get(JSON.stringify(recipe)),
      recipe: (id) => recipeList[id] ?? fail(`unknown recipe ${id}`)
    } satisfies RecipeRegistry)
  };
}

function inlineInputRecipe(reg: "eax" | "ebx"): ExprRecipe {
  return inlineRecipe(exprInput({ kind: "reg", reg }));
}

function inlineRecipe(expr: ExprRecipeForInline): ExprRecipe {
  return Object.freeze({ kind: "inline", expr } satisfies ExprRecipe);
}

function savedExprRecipe(saved: SavedExprId): ExprRecipe {
  return Object.freeze({ kind: "saved-expr", saved } satisfies ExprRecipe);
}

function sourceUse(use: LayoutValueUseId): WasmCacheOccurrenceSource {
  return Object.freeze({
    kind: "layout-use",
    use
  } satisfies WasmCacheOccurrenceSource);
}

function region(id: number, path: LayoutRegion["path"] = Object.freeze({ kind: "main" })): LayoutRegion {
  return Object.freeze({
    id: id as LayoutRegionId,
    path,
    steps: Object.freeze([])
  });
}

function edgePath(edge: number): LayoutRegion["path"] {
  return Object.freeze({
    kind: "edge",
    edge: edge as BlockEdgeId
  });
}

function savedId(id: number): SavedExprId {
  return id as SavedExprId;
}

function useId(id: number): LayoutValueUseId {
  return id as LayoutValueUseId;
}

function fail(message: string): never {
  throw new Error(message);
}

type ExprRecipeForInline = Extract<ExprRecipe, { kind: "inline" }>["expr"];
