import {
  deepStrictEqual,
  ok
} from "node:assert";
import { test } from "node:test";

import type {
  BlockEdgeId,
  BlockLayout,
  ExprRecipe,
  ExprRecipeId,
  LayoutRegion,
  LayoutRegionId,
  LayoutValueUseId,
  RecipeRegistry,
  StateWriteId,
  ValuePlan,
  ValueSnapshotId
} from "#ir/block/planning/index.js";
import {
  exprBinary,
  exprConst
} from "#ir/expr/builders.js";
import { exprChildren } from "#ir/expr/children.js";
import type { ExprRef } from "#ir/expr/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import {
  createWasmValueCache,
  wasmValueCacheOutput,
  type WasmValueCache
} from "#wasm/emit/cache/locals/index.js";
import {
  createWasmCacheLifetimeTracker,
  planWasmCacheLifetime,
  wasmCacheLifetimeKeepTracker,
  type WasmCacheLifetimeTracker
} from "#wasm/emit/cache/lifetime/index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan
} from "#wasm/emit/cache/plan/index.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";

test("Wasm cache lifetime plans direct selected value uses without StateWritePlan", () => {
  const main = region(0, { kind: "main" }, [
    writeValue(0, 10, selectedRecipe),
    writeValue(1, 11, selectedRecipe)
  ]);
  const cache = cachePlan([cacheEntry(0, selectedRecipe)]);
  const lifetime = planWasmCacheLifetime({
    layout: blockLayout([main]),
    values: recipeValues([selectedRecipe]),
    cachePlan: cache
  });

  deepStrictEqual(lifetime.budgets, [
    {
      entry: entryId(0),
      ownerRegion: regionId(0),
      remainingUses: 2
    }
  ]);
});

test("Wasm cache lifetime uses requiredSnapshots as the snapshot-to-entry bridge", () => {
  const snapshot = snapshotId(0);
  const snapshotRecipe = snapshotRefRecipe(snapshot);
  const main = region(0, { kind: "main" }, [
    writeValue(0, 20, snapshotRecipe),
    writeValue(1, 21, snapshotRecipe)
  ]);
  const cache = cachePlan([cacheEntry(0, selectedRecipe, [snapshot])]);
  const lifetime = planWasmCacheLifetime({
    layout: blockLayout([main]),
    values: recipeValues([selectedRecipe, snapshotRecipe]),
    cachePlan: cache
  });

  deepStrictEqual(lifetime.budgets, [
    {
      entry: entryId(0),
      ownerRegion: regionId(0),
      remainingUses: 2
    }
  ]);
});

test("Wasm cache lifetime tracker is counter-based and does not require ordered replay", () => {
  const tracker = createWasmCacheLifetimeTracker({
    budgets: [
      { entry: entryId(0), ownerRegion: regionId(0), remainingUses: 2 },
      { entry: entryId(1), ownerRegion: regionId(0), remainingUses: 1 }
    ]
  });

  deepStrictEqual(tracker.touchSelectedUse({
    entry: entryId(1),
    ownerRegion: regionId(0)
  }), { kind: "release" });
  deepStrictEqual(tracker.touchSelectedUse({
    entry: entryId(0),
    ownerRegion: regionId(0)
  }), { kind: "keep" });
  deepStrictEqual(tracker.touchSelectedUse({
    entry: entryId(0),
    ownerRegion: regionId(0)
  }), { kind: "release" });
});

test("Wasm cache lifetime tracker delays final stack release while a local borrow is live", () => {
  const tracker = createWasmCacheLifetimeTracker({
    budgets: [
      { entry: entryId(0), ownerRegion: regionId(0), remainingUses: 2 }
    ]
  });
  const borrow = tracker.borrowSelectedLocal({
    entry: entryId(0),
    ownerRegion: regionId(0)
  });

  deepStrictEqual(tracker.touchSelectedUse({
    entry: entryId(0),
    ownerRegion: regionId(0)
  }), { kind: "keep" });
  deepStrictEqual(borrow.release(), { kind: "release" });
});

test("Wasm value cache releases selected value outputs after the final stack use", () => {
  const main = region(0);
  const { body, cache, scratch } = createFixture(
    cachePlan([cacheEntry(0, selectedRecipe)]),
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker({
      budgets: [
        { entry: entryId(0), ownerRegion: regionId(0), remainingUses: 2 }
      ]
    })
  );

  cache.enterRegion(main);
  cache.emitUse({ id: useId(0), recipe: selectedRecipe }, inline(body, "first"));
  cache.emitUse({ id: useId(1), recipe: selectedRecipe }, inline(body, "second"));

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "first" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);

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

test("Wasm value cache releases selected local outputs only after local.release", () => {
  const main = region(0);
  const { body, cache, scratch } = createFixture(
    cachePlan([cacheEntry(0, selectedRecipe)]),
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker({
      budgets: [
        { entry: entryId(0), ownerRegion: regionId(0), remainingUses: 1 }
      ]
    })
  );

  cache.enterRegion(main);
  const emitted = cache.emitUse(
    { id: useId(0), recipe: selectedRecipe },
    inline(body, "local"),
    wasmValueCacheOutput.local
  );

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "local" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 }
  ]);

  emitted.release();

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "local" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "free", local: 0 }
  ]);

  cache.leaveRegion(main);
  scratch.assertClear();
});

test("Wasm value cache keeps selected local borrow alive across a later final stack use", () => {
  const main = region(0);
  const { body, cache, scratch } = createFixture(
    cachePlan([cacheEntry(0, selectedRecipe)]),
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker({
      budgets: [
        { entry: entryId(0), ownerRegion: regionId(0), remainingUses: 2 }
      ]
    })
  );

  cache.enterRegion(main);
  const local = cache.emitUse(
    { id: useId(0), recipe: selectedRecipe },
    inline(body, "local"),
    wasmValueCacheOutput.local
  );
  cache.emitUse({ id: useId(1), recipe: selectedRecipe }, inline(body, "stack"));

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "local" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 }
  ]);

  local.release();

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "local" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);

  cache.leaveRegion(main);
  scratch.assertClear();
});

test("Wasm cache lifetime emits no dead child budget when a parent local is visible", () => {
  const main = region(0, { kind: "main" }, [
    writeValue(0, 30, selectedRecipe)
  ]);
  const child = region(1, edgePath(1), [
    writeValue(1, 31, selectedRecipe)
  ]);
  const cachePlanInput = cachePlan([cacheEntry(0, selectedRecipe)]);
  const lifetimePlan = planWasmCacheLifetime({
    layout: blockLayout([main, child]),
    values: recipeValues([selectedRecipe]),
    cachePlan: cachePlanInput
  });
  const { body, cache, scratch } = createFixture(
    cachePlanInput,
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker(lifetimePlan)
  );

  deepStrictEqual(lifetimePlan.budgets, []);

  cache.enterRegion(main);
  cache.emitUse({ id: useId(0), recipe: selectedRecipe }, inline(body, "main"));
  cache.enterRegion(child);
  cache.emitUse({ id: useId(1), recipe: selectedRecipe }, inline(body, "child"));
  cache.leaveRegion(child);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "main" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 }
  ]);

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "main" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm cache lifetime lets child-region selected locals release before siblings", () => {
  const main = region(0);
  const child = region(1, edgePath(1), [
    writeValue(0, 40, selectedRecipe)
  ]);
  const sibling = region(2, edgePath(2), [
    writeValue(1, 41, selectedRecipe)
  ]);
  const cachePlanInput = cachePlan([cacheEntry(0, selectedRecipe)]);
  const lifetimePlan = planWasmCacheLifetime({
    layout: blockLayout([main, child, sibling]),
    values: recipeValues([selectedRecipe]),
    cachePlan: cachePlanInput
  });
  const { body, cache, scratch } = createFixture(
    cachePlanInput,
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker(lifetimePlan)
  );

  deepStrictEqual(lifetimePlan.budgets, [
    {
      entry: entryId(0),
      ownerRegion: regionId(1),
      remainingUses: 1
    },
    {
      entry: entryId(0),
      ownerRegion: regionId(2),
      remainingUses: 1
    }
  ]);

  cache.enterRegion(main);
  cache.enterRegion(child);
  cache.emitUse({ id: useId(0), recipe: selectedRecipe }, inline(body, "child"));
  cache.leaveRegion(child);
  cache.enterRegion(sibling);
  cache.emitUse({ id: useId(1), recipe: selectedRecipe }, inline(body, "sibling"));
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

test("Wasm cache lifetime keeps composite recipe interactions until region leave", () => {
  const parentRecipe = exprRecipe(exprBinary("add", exprConst(100), exprConst(200)));
  const main = region(0, { kind: "main" }, [
    writeValue(0, 50, selectedRecipe),
    writeValue(1, 51, parentRecipe)
  ]);
  const cachePlanInput = cachePlan([cacheEntry(0, selectedRecipe)]);
  const lifetimePlan = planWasmCacheLifetime({
    layout: blockLayout([main]),
    values: recipeValues([selectedRecipe, parentRecipe]),
    cachePlan: cachePlanInput
  });
  const { body, cache, scratch } = createFixture(
    cachePlanInput,
    recipeValues([selectedRecipe, parentRecipe]),
    createWasmCacheLifetimeTracker(lifetimePlan)
  );

  deepStrictEqual(lifetimePlan.budgets, []);

  cache.enterRegion(main);
  cache.emitUse({ id: useId(0), recipe: selectedRecipe }, inline(body, "selected"));

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "selected" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 }
  ]);

  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "selected" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("Wasm value cache keeps unselected local outputs scratch-owned and not region-visible", () => {
  const main = region(0);
  const { body, cache, scratch } = createFixture(
    cachePlan([]),
    recipeValues([selectedRecipe]),
    createWasmCacheLifetimeTracker({ budgets: [] })
  );

  cache.enterRegion(main);
  const local = cache.emitUse(
    { id: useId(0), recipe: selectedRecipe },
    inline(body, "local"),
    wasmValueCacheOutput.local
  );
  cache.emitUse(
    { id: useId(1), recipe: selectedRecipe },
    inline(body, "stack"),
    wasmValueCacheOutput.stack
  );
  local.release();
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "local" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "inline", label: "stack" },
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

const selectedRecipe = exprRecipe(exprConst(7));

function createFixture(
  plan: WasmCachePlan,
  values: ValuePlan,
  lifetime: WasmCacheLifetimeTracker = wasmCacheLifetimeKeepTracker
): Readonly<{
  body: RecordingBody;
  cache: WasmValueCache;
  scratch: RecordingScratch;
}> {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const cacheInput = {
    plan,
    values,
    body,
    scratch,
    lifetime
  };

  return {
    body,
    scratch,
    cache: createWasmValueCache(cacheInput)
  };
}

function inline(body: RecordingBody, label: string): () => WasmEmittedValue {
  return () => {
    body.ops.push({ kind: "inline", label });
    return wasmI32(32);
  };
}

function blockLayout(regions: readonly LayoutRegion[]): BlockLayout {
  return {
    regions: [...regions]
  };
}

function region(
  id: number,
  path: LayoutRegion["path"] = { kind: "main" },
  steps: LayoutRegion["steps"] = []
): LayoutRegion {
  return {
    id: regionId(id),
    path,
    steps: [...steps]
  };
}

function writeValue(id: number, use: number, recipe: ExprRecipe): LayoutRegion["steps"][number] {
  return {
    kind: "write-state",
    emit: id as StateWriteId,
    satisfies: [id as StateWriteId],
    value: {
      id: useId(use),
      recipe
    }
  };
}

function cachePlan(entries: readonly WasmCacheEntry[]): WasmCachePlan {
  return {
    entries: [...entries]
  };
}

function cacheEntry(
  id: number,
  recipe: ExprRecipe,
  requiredSnapshots: readonly ValueSnapshotId[] = []
): WasmCacheEntry {
  return {
    id: entryId(id),
    recipe,
    requiredSnapshots: [...requiredSnapshots]
  };
}

function recipeValues(recipes: readonly ExprRecipe[]): ValuePlan {
  const recipeList: ExprRecipe[] = [];
  const idByKey = new Map<string, ExprRecipeId>();

  for (const recipe of recipes) {
    recordRecipe(recipe, recipeList, idByKey);
  }

  return {
    snapshots: [],
    recipes: {
      recipeForNeed: () => undefined,
      recipeIdForNeed: () => undefined,
      recipeId: (recipe) => idByKey.get(JSON.stringify(recipe)),
      recipe: (id) => {
        const recipe = recipeList[id];

        ok(recipe !== undefined, `unknown recipe ${id}`);
        return recipe;
      }
    } satisfies RecipeRegistry
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

function exprRecipe(expr: ExprRef): ExprRecipe {
  return exprRecipeWithChildren(expr, exprChildren(expr).map(exprRecipe));
}

function exprRecipeWithChildren(expr: ExprRef, children: readonly ExprRecipe[]): ExprRecipe {
  return {
    kind: "expr",
    expr,
    children: [...children]
  };
}

function snapshotRefRecipe(snapshot: ValueSnapshotId): ExprRecipe {
  return { kind: "snapshot", snapshot };
}

function edgePath(edge: number): LayoutRegion["path"] {
  return {
    kind: "edge",
    edge: edge as BlockEdgeId
  };
}

function entryId(id: number): WasmCacheEntryId {
  return id as WasmCacheEntryId;
}

function regionId(id: number): LayoutRegionId {
  return id as LayoutRegionId;
}

function snapshotId(id: number): ValueSnapshotId {
  return id as ValueSnapshotId;
}

function useId(id: number): LayoutValueUseId {
  return id as LayoutValueUseId;
}
