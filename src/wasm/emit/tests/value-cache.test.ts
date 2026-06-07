import {
  deepStrictEqual
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
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import { exprChildren } from "#ir/expr/children.js";
import type { ExprRef } from "#ir/expr/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan,
  WasmCacheReason
} from "#wasm/emit/cache/plan/index.js";
import {
  createWasmValueCache,
  type WasmValueCache
} from "#wasm/emit/cache/locals/index.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";

test("Wasm value cache emits local.tee for first selected use and local.get for later use", () => {
  const main = region(0);
  const recipe = exprInputRecipe("eax");
  const useA = useId(10);
  const useB = useId(11);
  const plan = cachePlan([cacheEntry(0, recipe)]);
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

test("Wasm value cache preserves cached value width on local.get", () => {
  const main = region(0);
  const recipe = exprInputRecipe("eax");
  const useA = useId(13);
  const useB = useId(14);
  const plan = cachePlan([cacheEntry(0, recipe)]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  const first = cache.emitUse({ id: useA, recipe }, inline(body, "first", 8));
  const second = cache.emitUse({ id: useB, recipe }, inline(body, "second", 32));
  cache.leaveRegion(main);

  deepStrictEqual(first, wasmI32(8));
  deepStrictEqual(second, wasmI32(8));
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
  const recipe = exprInputRecipe("eax");
  const use = useId(10);
  const { body, cache, scratch } = createFixture(cachePlan([]), [recipe]);

  cache.enterRegion(main);
  cache.emitUse({ id: use, recipe }, inline(body, "unselected"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "unselected" }
  ]);
  scratch.assertClear();
});

test("Wasm value cache releases selected locals on region leave", () => {
  const main = region(0);
  const recipe = exprInputRecipe("eax");
  const use = useId(12);
  const plan = cachePlan([cacheEntry(0, recipe)]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitUse({ id: use, recipe }, inline(body, "first"));

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 }
  ]);

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache keeps snapshot expression locals until region leave", () => {
  const main = region(0);
  const snapshot = snapshotId(0);
  const snapshotSourceRecipe = exprInputRecipe("eax");
  const laterRecipe = exprRecipe(exprBinary("add", exprConst(2), exprConst(1)));
  const snapshotUse = useId(20);
  const laterUseA = useId(21);
  const laterUseB = useId(22);
  const plan = cachePlan([
    cacheEntry(0, snapshotSourceRecipe, [{ kind: "required-snapshot", snapshot }]),
    cacheEntry(1, laterRecipe)
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.ensureSnapshot(snapshot, snapshotSourceRecipe, inline(body, "establish"));
  cache.emitUse({ id: snapshotUse, recipe: snapshotRefRecipe(snapshot) }, inline(body, "snapshot-use"));
  cache.emitUse({ id: laterUseA, recipe: laterRecipe }, inline(body, "later-first"));
  cache.emitUse({ id: laterUseB, recipe: laterRecipe }, inline(body, "later-second"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "establish" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 },
    { kind: "inline", label: "later-first" },
    { kind: "alloc", local: 1, type: wasmValueType.i32 },
    { kind: "tee", local: 1 },
    { kind: "get", local: 1 },
    { kind: "free", local: 0 },
    { kind: "free", local: 1 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache emits parent snapshot expressions in child regions", () => {
  const main = region(0);
  const edge = region(1, edgePath(1));
  const snapshot = snapshotId(0);
  const snapshotSourceRecipe = exprInputRecipe("eax");
  const plan = cachePlan([cacheEntry(0, snapshotSourceRecipe, [{ kind: "required-snapshot", snapshot }])]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.ensureSnapshot(snapshot, snapshotSourceRecipe, inline(body, "establish"));

  cache.enterRegion(edge);
  cache.emitSnapshot(snapshot);
  cache.leaveRegion(edge);

  cache.emitSnapshot(snapshot);
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "establish" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache keeps selected locals until region leave", () => {
  const main = region(0);
  const recipeA = exprRecipe(exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1)));
  const recipeB = exprRecipe(exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(2)));
  const useA0 = useId(100);
  const useB = useId(101);
  const useA1 = useId(102);
  const { body, cache, scratch } = createFixture(cachePlan([
    cacheEntry(0, recipeA),
    cacheEntry(1, recipeB)
  ]));

  cache.enterRegion(main);
  cache.emitUse({ id: useA0, recipe: recipeA }, inline(body, "a-first"));
  cache.emitUse({ id: useB, recipe: recipeB }, inline(body, "b-first"));
  cache.emitUse({ id: useA1, recipe: recipeA }, inline(body, "a-second"));
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "a-first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "inline", label: "b-first" },
    { kind: "alloc", local: 1, type: wasmValueType.i32 },
    { kind: "tee", local: 1 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 },
    { kind: "free", local: 1 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache inherits parent selected locals into child regions", () => {
  const main = region(0);
  const edge = region(1, edgePath(1));
  const recipe = exprInputRecipe("eax");
  const mainUseA = useId(200);
  const edgeUse = useId(201);
  const mainUseB = useId(202);
  const plan = cachePlan([
    cacheEntry(0, recipe)
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);
  cache.emitUse({ id: mainUseA, recipe }, inline(body, "main-first"));

  cache.enterRegion(edge);
  cache.emitUse({ id: edgeUse, recipe }, inline(body, "edge-should-not-run"));
  cache.leaveRegion(edge);

  cache.emitUse({ id: mainUseB, recipe }, inline(body, "main-second"));

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "main-first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache releases child locals without exposing them to siblings", () => {
  const main = region(0);
  const child = region(1, edgePath(1));
  const sibling = region(2, edgePath(2));
  const recipe = exprInputRecipe("eax");
  const childUse = useId(300);
  const siblingUse = useId(301);
  const plan = cachePlan([
    cacheEntry(0, recipe)
  ]);
  const { body, cache, scratch } = createFixture(plan);

  cache.enterRegion(main);

  cache.enterRegion(child);
  cache.emitUse({ id: childUse, recipe }, inline(body, "child"));
  cache.leaveRegion(child);

  cache.enterRegion(sibling);
  cache.emitUse({ id: siblingUse, recipe }, inline(body, "sibling"));
  cache.leaveRegion(sibling);

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "child" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 },
    { kind: "inline", label: "sibling" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
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

function inline(body: RecordingBody, label: string, width: 8 | 16 | 32 = 32): () => WasmEmittedValue {
  return () => {
    body.ops.push({ kind: "inline", label });
    return wasmI32(width);
  };
}

function cachePlan(
  entries: readonly WasmCacheEntry[]
): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze([...entries])
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

function recipeValues(recipes: readonly ExprRecipe[]): Pick<ValuePlan, "recipes"> {
  const recipeList: ExprRecipe[] = [];
  const idByKey = new Map<string, ExprRecipeId>();

  for (const recipe of recipes) {
    recordRecipe(recipe, recipeList, idByKey);
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

function recordRecipe(
  recipe: ExprRecipe,
  recipeList: ExprRecipe[],
  idByKey: Map<string, ExprRecipeId>
): void {
  switch (recipe.kind) {
    case "expr":
      for (const child of recipe.children) {
        recordRecipe(child, recipeList, idByKey);
      }
      break;
    case "definition":
      recordRecipe(recipe.input, recipeList, idByKey);
      break;
    case "snapshot":
      break;
  }

  const key = JSON.stringify(recipe);

  if (idByKey.has(key)) {
    return;
  }

  idByKey.set(key, recipeList.length as ExprRecipeId);
  recipeList.push(recipe);
}

function exprInputRecipe(reg: "eax" | "ebx"): ExprRecipe {
  return exprRecipe(exprInput({ kind: "reg", reg }));
}

function exprRecipe(expr: ExprRef): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze(exprChildren(expr).map(exprRecipe))
  } satisfies ExprRecipe);
}

function snapshotRefRecipe(snapshot: ValueSnapshotId): ExprRecipe {
  return Object.freeze({ kind: "snapshot", snapshot } satisfies ExprRecipe);
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

function snapshotId(id: number): ValueSnapshotId {
  return id as ValueSnapshotId;
}

function useId(id: number): LayoutValueUseId {
  return id as LayoutValueUseId;
}

function fail(message: string): never {
  throw new Error(message);
}
