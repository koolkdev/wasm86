import {
  deepStrictEqual,
  doesNotMatch,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  LayoutRegion,
  LayoutRegionId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  RecipeRegistry,
  ValueSnapshotId,
  ValuePlan
} from "#ir/block/planning/values/index.js";
import { exprChildren } from "#ir/expr/children.js";
import {
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprProject,
  exprSelect,
  exprUnary
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import { reg32, type OperandWidth, type Reg32 } from "#x86/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmOpcode,
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import {
  createWasmValueCache,
  type WasmValueCache
} from "#wasm/emit/cache/locals/index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan,
  WasmCacheReason
} from "#wasm/emit/cache/plan/index.js";
import { emitLoadGuestMemoryUnchecked } from "#wasm/emit/ops/memory.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";
import {
  createWasmSourceReader,
  type WasmReadableInputSource,
  type WasmSourceReadPlacement,
  type WasmSourceReader
} from "#wasm/emit/sources/storage.js";
import {
  createWasmRecipeEmitter,
  type WasmDefinitionRecipeEmitter,
  type WasmDefinitionRecipeInfo,
  type WasmRecipeEmitter
} from "#wasm/emit/values/recipes.js";

test("expr recipes emit child recipes instead of raw expression children", () => {
  const rawExpr = exprBinary("add", exprConst(100), exprConst(200));
  const recipe = Object.freeze({
    kind: "expr",
    expr: rawExpr,
    children: Object.freeze([
      exprRecipe(exprConst(1)),
      exprRecipe(exprConst(2))
    ])
  } satisfies ExprRecipe);
  const { body, emitter } = createFixture(cachePlan([]), [recipe]);

  emitter.emitRecipe(recipe);

  deepStrictEqual(body.ops, [
    { kind: "const", value: 1 },
    { kind: "const", value: 2 },
    { kind: "add" }
  ]);
});

test("raw input(def) expression emission fails clearly", () => {
  const recipe = exprRecipe(exprInput({ kind: "def", id: 7 }));
  const { emitter } = createFixture(cachePlan([]), [recipe]);

  throws(
    () => emitter.emitRecipe(recipe),
    /raw input\(def 7\).*definition recipe.*snapshot recipe/
  );
});

test("input expressions read through source storage", () => {
  const recipe = exprRecipe(exprInput({ kind: "reg", reg: "eax" }));
  const body = new RecordingBody();
  const sources: WasmSourceReader = {
    emitInput: (source) => {
      if (source.kind !== "reg") {
        throw new Error("unexpected flag source read");
      }

      strictEqual(source.reg, "eax");
      body.localGet(13);
      return wasmI32(32);
    },
    tryEmitRegisterAliasInput: () => {
      ok(false, "unexpected register alias source read");
      return undefined;
    }
  };
  const definitions: WasmDefinitionRecipeEmitter = {
    definitionInfo: () => undefined,
    emitDefinition: () => wasmI32(32)
  };
  const { emitter } = createFixtureWithBody(body, cachePlan([]), [recipe], definitions, { sources });

  emitter.emitRecipe(recipe);

  deepStrictEqual(body.ops, [
    { kind: "get", local: 13 }
  ]);
});

test("default source reader places recipe inputs through a placement plan", () => {
  const recipe = exprRecipe(exprInput({ kind: "flag", flag: "ZF" }));
  const { body, emitter } = createFixture(cachePlan([]), [recipe]);

  emitter.emitRecipe(recipe);

  deepStrictEqual(body.ops, [
    { kind: "get", local: reg32.length },
    { kind: "const", value: 3 },
    { kind: "const", value: 1 }
  ]);
});

test("source reader rejects invalid register placements before emitting", () => {
  assertRejectedSourcePlacement(
    { kind: "reg", reg: "eax" },
    { kind: "packed-flag-local", local: 1 },
    /register input eax cannot use packed flag placement packed-flag-local/
  );
  assertRejectedSourcePlacement(
    { kind: "reg", reg: "eax" },
    { kind: "packed-flag-state", state: { offset: 0, width: 32 } },
    /register input eax cannot use packed flag placement packed-flag-state/
  );
  assertRejectedSourcePlacement(
    { kind: "reg", reg: "eax" },
    { kind: "state.i32", state: { offset: 0, width: 16 } },
    /register input eax must use a 32-bit state placement, got 16-bit state placement/
  );
});

test("source reader rejects unpacked flag placements before emitting", () => {
  assertRejectedSourcePlacement(
    { kind: "flag", flag: "ZF" },
    { kind: "local.i32", local: 1 },
    /flag input ZF must use a packed flag placement, got local\.i32/
  );
  assertRejectedSourcePlacement(
    { kind: "flag", flag: "ZF" },
    { kind: "state.i32", state: { offset: 0, width: 32 } },
    /flag input ZF must use a packed flag placement, got state\.i32/
  );
});

test("snapshot recipes emit through the value cache", () => {
  const main = region(0);
  const snapshot = snapshotId(0);
  const sourceRecipe = exprRecipe(exprConst(11));
  const snapshotRecipe = Object.freeze({ kind: "snapshot", snapshot } satisfies ExprRecipe);
  const plan = cachePlan([
    cacheEntry(0, sourceRecipe, [{ kind: "required-snapshot", snapshot }])
  ]);
  const { body, cache, emitter, scratch } = createFixture(plan, [snapshotRecipe]);

  cache.enterRegion(main);
  emitter.establishSnapshot(snapshot, sourceRecipe);
  emitter.emitRecipe(snapshotRecipe);
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "const", value: 11 },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "get", local: 0 },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("cached child recipes establish and reuse locals while emitting a parent expression", () => {
  const main = region(0);
  const child = exprRecipe(exprConst(3));
  const parent = Object.freeze({
    kind: "expr",
    expr: exprBinary("add", exprConst(100), exprConst(200)),
    children: Object.freeze([child, child])
  } satisfies ExprRecipe);
  const plan = cachePlan([
    cacheEntry(0, child)
  ]);
  const { body, cache, emitter, scratch } = createFixture(plan, [parent]);

  cache.enterRegion(main);
  emitter.emitRecipe(parent);
  cache.leaveRegion(main);

  deepStrictEqual(body.ops, [
    { kind: "const", value: 3 },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 },
    { kind: "add" },
    { kind: "free", local: 0 }
  ]);
  scratch.assertClear();
});

test("select emits semantic children in Wasm operand order without temp locals", () => {
  const recipe = exprRecipe(exprSelect(exprConst(0), exprConst(1), exprConst(2)));
  const { body, emitter } = createFixture(cachePlan([]), [recipe]);

  emitter.emitRecipe(recipe);

  deepStrictEqual(body.ops, [
    { kind: "const", value: 1 },
    { kind: "const", value: 2 },
    { kind: "const", value: 0 },
    { kind: "select" }
  ]);
});

test("signed compare sign-extends operands without pre-mask", () => {
  const recipe = exprRecipe(exprCompare(8, "lt_s", exprConst(0x80), exprConst(0x7f)));
  const { body, emitter } = createFixture(cachePlan([]), [recipe]);

  emitter.emitRecipe(recipe);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), false);
});

test("signed extension over direct memory-load definition emits a signed load", () => {
  const def = definitionId(1);
  const address = exprRecipe(exprConst(4));
  const load = definitionRecipe(def, address);
  const recipe = Object.freeze({
    kind: "expr",
    expr: exprUnary("extend8_s", exprInput({ kind: "def", id: def })),
    children: Object.freeze([load])
  } satisfies ExprRecipe);
  const body = new WasmFunctionBodyEncoder();
  const definitions = new MemoryLoadDefinitions(body, [[def, 8]]);
  const { emitter } = createFixtureWithBody(body, cachePlan([]), [recipe], definitions);

  emitter.emitRecipe(recipe);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(definitions.calls.length, 1);
  strictEqual(definitions.calls[0]?.signed, true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), false);
});

test("signed extension over snapshot memory-load result does not bypass the snapshot", () => {
  const main = region(0);
  const def = definitionId(2);
  const snapshot = snapshotId(2);
  const address = exprRecipe(exprConst(8));
  const load = definitionRecipe(def, address);
  const snapshotRecipe = Object.freeze({ kind: "snapshot", snapshot } satisfies ExprRecipe);
  const recipe = Object.freeze({
    kind: "expr",
    expr: exprUnary("extend8_s", exprInput({ kind: "def", id: def })),
    children: Object.freeze([snapshotRecipe])
  } satisfies ExprRecipe);
  const body = new WasmFunctionBodyEncoder();
  const definitions = new MemoryLoadDefinitions(body, [[def, 8]]);
  const plan = cachePlan([
    cacheEntry(0, load, [{ kind: "required-snapshot", snapshot }])
  ]);
  const { cache, emitter } = createFixtureWithBody(body, plan, [recipe, snapshotRecipe], definitions);

  cache.enterRegion(main);
  emitter.establishSnapshot(snapshot, load);
  emitter.emitRecipe(recipe);
  cache.leaveRegion(main);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  deepStrictEqual(definitions.calls.map((call) => call.signed), [false]);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
});

test("signed extension over selected direct memory-load child preserves cache ownership", () => {
  const main = region(4);
  const def = definitionId(4);
  const address = exprRecipe(exprConst(16));
  const load = definitionRecipe(def, address);
  const recipe = Object.freeze({
    kind: "expr",
    expr: exprUnary("extend8_s", exprInput({ kind: "def", id: def })),
    children: Object.freeze([load])
  } satisfies ExprRecipe);
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const definitions = new MemoryLoadDefinitions(body, [[def, 8]]);
  const plan = cachePlan([
    cacheEntry(0, load, [{ kind: "reuse", estimatedBenefit: 1 }])
  ]);
  const { cache, emitter } = createFixtureWithBody(
    body,
    plan,
    [recipe],
    definitions,
    { scratch }
  );

  cache.enterRegion(main);
  emitter.emitRecipe(recipe);
  cache.leaveRegion(main);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  deepStrictEqual(definitions.calls.map((call) => call.signed), [false]);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  deepStrictEqual(body.ops.filter(isCacheLocalOp), [
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "free", local: 0 }
  ]);
});

test("snapshot establishment can fuse a signed view over a memory-load definition", () => {
  const main = region(0);
  const def = definitionId(3);
  const snapshot = snapshotId(3);
  const address = exprRecipe(exprConst(12));
  const load = definitionRecipe(def, address);
  const signedView = Object.freeze({
    kind: "expr",
    expr: exprUnary("extend16_s", exprInput({ kind: "def", id: def })),
    children: Object.freeze([load])
  } satisfies ExprRecipe);
  const body = new WasmFunctionBodyEncoder();
  const definitions = new MemoryLoadDefinitions(body, [[def, 16]]);
  const plan = cachePlan([
    cacheEntry(0, signedView, [{ kind: "required-snapshot", snapshot }])
  ]);
  const { cache, emitter } = createFixtureWithBody(body, plan, [signedView], definitions);

  cache.enterRegion(main);
  emitter.establishSnapshot(snapshot, signedView);
  cache.leaveRegion(main);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  deepStrictEqual(definitions.calls.map((call) => call.signed), [true]);
  strictEqual(opcodes.includes(wasmOpcode.i32Load16S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend16S), false);
});

test("project over unsigned narrow memory-load definitions does not emit redundant masks", () => {
  for (const width of [8, 16] as const) {
    const def = definitionId(width);
    const address = exprRecipe(exprConst(width));
    const load = definitionRecipe(def, address);
    const recipe = exprRecipeWithChildren(
      exprProject(width, exprInput({ kind: "def", id: def })),
      [load]
    );
    const body = new WasmFunctionBodyEncoder();
    const definitions = new MemoryLoadDefinitions(body, [[def, width]]);
    const { emitter } = createFixtureWithBody(body, cachePlan([]), [recipe], definitions);

    deepStrictEqual(emitter.emitRecipe(recipe), wasmI32(width));
    body.end();

    const opcodes = wasmBodyOpcodes(body.encode());

    strictEqual(opcodes.includes(width === 8 ? wasmOpcode.i32Load8U : wasmOpcode.i32Load16U), true);
    strictEqual(opcodes.includes(wasmOpcode.i32And), false);
  }
});

test("project over signed narrow memory-load definitions still masks to unsigned width", () => {
  const def = definitionId(18);
  const address = exprRecipe(exprConst(18));
  const load = definitionRecipe(def, address);
  const signedExpr = exprUnary("extend8_s", exprInput({ kind: "def", id: def }));
  const signedLoad = exprRecipeWithChildren(
    signedExpr,
    [load]
  );
  const recipe = exprRecipeWithChildren(exprProject(8, signedExpr), [signedLoad]);
  const body = new WasmFunctionBodyEncoder();
  const definitions = new MemoryLoadDefinitions(body, [[def, 8]]);
  const { emitter } = createFixtureWithBody(body, cachePlan([]), [recipe], definitions);

  deepStrictEqual(emitter.emitRecipe(recipe), wasmI32(8));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
});

test("project over compare results does not emit a redundant mask", () => {
  const compareExpr = exprCompare(8, "eq", exprConst(1), exprConst(2));
  const compare = exprRecipe(compareExpr);
  const recipe = exprRecipeWithChildren(exprProject(8, compareExpr), [compare]);
  const { body, emitter } = createFixture(cachePlan([]), [recipe]);

  deepStrictEqual(emitter.emitRecipe(recipe), wasmI32(8));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(opcodes.includes(wasmOpcode.i32Eq), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), false);
});

test("add result width grows from narrow unsigned operands", () => {
  const add8 = exprRecipe(exprBinary("add", exprConst(1), exprConst(2)));
  const add16 = exprRecipe(exprBinary("add", exprConst(0x100), exprConst(0x200)));
  const fixture8 = createFixture(cachePlan([]), [add8]);
  const fixture16 = createFixture(cachePlan([]), [add16]);

  deepStrictEqual(fixture8.emitter.emitRecipe(add8), wasmI32(16));
  deepStrictEqual(fixture16.emitter.emitRecipe(add16), wasmI32(32));
});

test("simple bitwise and right-shift result widths stay narrow", () => {
  const and = exprRecipe(exprBinary("and", exprConst(0xff), exprConst(0x1234)));
  const or = exprRecipe(exprBinary("or", exprConst(0xff), exprConst(0x1200)));
  const xor = exprRecipe(exprBinary("xor", exprConst(0xff), exprConst(0x1200)));
  const shr = exprRecipe(exprBinary("shr_u", exprConst(0x1234), exprConst(1)));

  deepStrictEqual(createFixture(cachePlan([]), [and]).emitter.emitRecipe(and), wasmI32(8));
  deepStrictEqual(createFixture(cachePlan([]), [or]).emitter.emitRecipe(or), wasmI32(16));
  deepStrictEqual(createFixture(cachePlan([]), [xor]).emitter.emitRecipe(xor), wasmI32(16));
  deepStrictEqual(createFixture(cachePlan([]), [shr]).emitter.emitRecipe(shr), wasmI32(16));
});

test("stage 14 value widths keep recipe orchestration separate from expression lowering", async () => {
  const fs = await import("node:fs/promises");
  const recipeSource = await fs.readFile("src/wasm/emit/values/recipes.ts", "utf8");
  const expressionSource = await fs.readFile("src/wasm/emit/values/expressions.ts", "utf8");

  doesNotMatch(recipeSource, /WasmStackValueWidth|cleanWidth|dirty|unknown/);
  doesNotMatch(expressionSource, /WasmStackValueWidth|cleanWidth|dirty|unknown/);
  doesNotMatch(recipeSource, /\.\.\/ops\/|#x86\/(?:numeric|registers)|exprChildren/);
});

type RecordedOp =
  | Readonly<{ kind: "alloc"; local: number; type: WasmValueType }>
  | Readonly<{ kind: "free"; local: number }>
  | Readonly<{ kind: "get"; local: number }>
  | Readonly<{ kind: "set"; local: number }>
  | Readonly<{ kind: "tee"; local: number }>
  | Readonly<{ kind: "const"; value: number }>
  | Readonly<{ kind: "add" }>
  | Readonly<{ kind: "select" }>;

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly ops: RecordedOp[] = [];

  override addLocal(type: WasmValueType): number {
    const local = super.addLocal(type);

    this.ops.push({ kind: "alloc", local, type });
    return local;
  }

  override localGet(index: number): this {
    super.localGet(index);
    this.ops.push({ kind: "get", local: index });
    return this;
  }

  override localSet(index: number): this {
    super.localSet(index);
    this.ops.push({ kind: "set", local: index });
    return this;
  }

  override localTee(index: number): this {
    super.localTee(index);
    this.ops.push({ kind: "tee", local: index });
    return this;
  }

  override i32Const(value: number): this {
    super.i32Const(value);
    this.ops.push({ kind: "const", value });
    return this;
  }

  override i32Add(): this {
    super.i32Add();
    this.ops.push({ kind: "add" });
    return this;
  }

  override select(): this {
    super.select();
    this.ops.push({ kind: "select" });
    return this;
  }
}

class RecordingScratch extends WasmLocalScratchAllocator {
  readonly #ops: RecordedOp[];

  constructor(body: RecordingBody) {
    super(body);
    this.#ops = body.ops;
  }

  override freeLocal(index: number): void {
    super.freeLocal(index);
    this.#ops.push({ kind: "free", local: index });
  }
}

type MemoryLoadCall = Readonly<{
  definition: BlockDefinitionId;
  signed: boolean;
}>;

class MemoryLoadDefinitions implements WasmDefinitionRecipeEmitter {
  readonly calls: MemoryLoadCall[] = [];
  readonly #body: WasmFunctionBodyEncoder;
  readonly #definitions = new Map<BlockDefinitionId, WasmDefinitionRecipeInfo>();

  constructor(
    body: WasmFunctionBodyEncoder,
    definitions: readonly (readonly [BlockDefinitionId, OperandWidth])[]
  ) {
    this.#body = body;

    for (const [definition, width] of definitions) {
      this.#definitions.set(definition, { kind: "memoryLoad", width });
    }
  }

  definitionInfo(definition: BlockDefinitionId): WasmDefinitionRecipeInfo | undefined {
    return this.#definitions.get(definition);
  }

  emitDefinition(
    definition: BlockDefinitionId,
    emitInput: () => WasmEmittedValue,
    options: { signed?: boolean } = {}
  ): WasmEmittedValue {
    const info = this.#definitions.get(definition);

    if (info === undefined) {
      throw new Error(`unknown test definition ${definition}`);
    }

    this.calls.push({
      definition,
      signed: options.signed === true
    });
    ok(info.kind === "memoryLoad", `expected memory-load test definition ${definition}, got ${info.kind}`);

    return emitLoadGuestMemoryUnchecked(
      this.#body,
      emitInput,
      info.width,
      options.signed === true
    );
  }
}

function createFixture(
  plan: WasmCachePlan,
  extraRecipes: readonly ExprRecipe[] = []
): Readonly<{
  body: RecordingBody;
  cache: WasmValueCache;
  emitter: WasmRecipeEmitter;
  scratch: RecordingScratch;
}> {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const definitions: WasmDefinitionRecipeEmitter = {
    definitionInfo: () => undefined,
    emitDefinition: () => wasmI32(32)
  };
  const fixture = createFixtureWithBody(body, plan, extraRecipes, definitions, { scratch });

  return {
    body,
    cache: fixture.cache,
    emitter: fixture.emitter,
    scratch
  };
}

function createFixtureWithBody(
  body: WasmFunctionBodyEncoder,
  plan: WasmCachePlan,
  extraRecipes: readonly ExprRecipe[],
  definitions: WasmDefinitionRecipeEmitter,
  options: Readonly<{
    scratch?: WasmLocalScratchAllocator;
    sources?: WasmSourceReader;
  }> = {}
): Readonly<{
  cache: WasmValueCache;
  emitter: WasmRecipeEmitter;
}> {
  const recipes = plan.entries.map((entry) => entry.recipe);
  const cache = createWasmValueCache({
    plan,
    values: recipeValues([...recipes, ...extraRecipes]),
    body,
    ...(options.scratch === undefined ? {} : { scratch: options.scratch })
  });
  const registers = Object.fromEntries(
    reg32.map((reg, index) => [reg, index])
  ) as Record<Reg32, number>;
  const sources = options.sources ?? createWasmSourceReader(body, {
    placement: (source) => {
      switch (source.kind) {
        case "reg":
          return { kind: "local.i32", local: registers[source.reg] };
        case "flag":
          return { kind: "packed-flag-local", local: reg32.length };
      }
    }
  });

  return {
    cache,
    emitter: createWasmRecipeEmitter({
      body,
      cache,
      definitions,
      sources
    })
  };
}

function assertRejectedSourcePlacement(
  source: WasmReadableInputSource,
  placement: WasmSourceReadPlacement,
  message: RegExp
): void {
  const body = new RecordingBody();
  const sources = createWasmSourceReader(body, {
    placement: () => placement
  });

  throws(
    () => sources.emitInput(source),
    message
  );
  deepStrictEqual(body.ops, []);
}

function isCacheLocalOp(op: RecordedOp): op is Extract<RecordedOp, { kind: "alloc" | "tee" | "free" }> {
  return op.kind === "alloc" || op.kind === "tee" || op.kind === "free";
}

function cachePlan(entries: readonly WasmCacheEntry[]): WasmCachePlan {
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

function exprRecipe(expr: ExprRef): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze(exprChildren(expr).map(exprRecipe))
  } satisfies ExprRecipe);
}

function exprRecipeWithChildren(expr: ExprRef, children: readonly ExprRecipe[]): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze([...children])
  } satisfies ExprRecipe);
}

function definitionRecipe(definition: BlockDefinitionId, input: ExprRecipe): ExprRecipe {
  return Object.freeze({
    kind: "definition",
    definition,
    input
  } satisfies ExprRecipe);
}

function region(id: number, path: LayoutRegion["path"] = Object.freeze({ kind: "main" })): LayoutRegion {
  return Object.freeze({
    id: id as LayoutRegionId,
    path,
    steps: Object.freeze([])
  });
}

function snapshotId(id: number): ValueSnapshotId {
  return id as ValueSnapshotId;
}

function definitionId(id: number): BlockDefinitionId {
  return id as BlockDefinitionId;
}

function fail(message: string): never {
  throw new Error(message);
}
