import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  definitionExpr,
  type BlockDefinition,
  type BlockDefinitionId
} from "#ir/block/definitions.js";
import type {
  DefinitionResult,
  ExprRecipe,
  ExprRecipeId,
  LayoutRegion,
  LayoutRegionId,
  ProgramPoint,
  RecipeRegistry,
  ValuePlan
} from "#ir/block/planning/index.js";
import type { BlockDefinitionSite, Placement } from "#ir/block/timeline.js";
import { opSite } from "#ir/block/walk/site.js";
import { exprConst } from "#ir/expr/builders.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmOpcode, type WasmValueType } from "#wasm/encoder/types.js";
import { createWasmDefinitionRecipeEmitter } from "#wasm/emit/block/definitions.js";
import { createWasmValueCache } from "#wasm/emit/cache/locals/index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan
} from "#wasm/emit/cache/plan/index.js";
import { createWasmRecipeEmitter } from "#wasm/emit/values/recipes.js";
import { createWasmSourceReader } from "#wasm/emit/sources/storage.js";
import { wasmBodyMemoryAccesses, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";

test("memory-load definition metadata is replayable without emitting by itself", () => {
  const body = new RecordingBody();
  const definition = memoryLoadDefinition(0, 8);
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)]
  });

  deepStrictEqual(body.events, []);
  deepStrictEqual(definitions.definitionInfo(definition.id), {
    kind: "memoryLoad",
    width: 8
  });
});

test("used memory-load definition emits once through a selected recipe cache path", () => {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const definition = memoryLoadDefinition(1, 32);
  const load = definitionRecipe(definition.id, exprRecipe(4));
  const plan = cachePlan([cacheEntry(0, load)]);
  const cache = createWasmValueCache({
    plan,
    values: recipeValues([load]),
    body,
    scratch
  });
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)]
  });
  const recipes = createWasmRecipeEmitter({
    body,
    cache,
    definitions,
    sources: createWasmSourceReader(body, {
      placement: () => ({ kind: "local.i32", local: 0 })
    })
  });
  const main = region(0);

  cache.enterRegion(main);
  recipes.emitRecipe(load);
  recipes.emitRecipe(load);
  cache.leaveRegion(main);
  body.end();

  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [
    { opcode: wasmOpcode.i32Load, memoryIndex: wasmMemoryIndex.guest, offset: 0 }
  ]);
  deepStrictEqual(body.events.filter((event) => event.kind === "tee" || event.kind === "get"), [
    { kind: "tee", local: 0 },
    { kind: "get", local: 0 }
  ]);
  scratch.assertClear();
});

test("signed memory-load definitions lower to signed Wasm loads when requested", () => {
  for (const [id, width, opcode] of [
    [8, 8, wasmOpcode.i32Load8S],
    [16, 16, wasmOpcode.i32Load16S]
  ] as const) {
    const body = new WasmFunctionBodyEncoder();
    const definition = memoryLoadDefinition(id, width);
    const definitions = createWasmDefinitionRecipeEmitter({
      body,
      definitions: [definitionMetadata(definition)]
    });

    definitions.emitDefinition(
      definition.id,
      () => {
        body.i32Const(0);
        return { wasmType: "i32", width: 32 };
      },
      { signed: true }
    );
    body.end();

    strictEqual(wasmBodyOpcodes(body.encode()).includes(opcode), true);
  }
});

test("dynamic-register-load definition throws clearly until implemented", () => {
  const body = new WasmFunctionBodyEncoder();
  const definition = Object.freeze({
    kind: "dynamicRegisterLoad",
    id: definitionId(2),
    at: opSite(0),
    result: { kind: "def", id: definitionId(2) },
    index: exprConst(3),
    width: 32
  } satisfies BlockDefinition);
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)]
  });

  throws(
    () => definitions.emitDefinition(definition.id, () => {
      body.i32Const(3);
      return { wasmType: "i32", width: 32 };
    }),
    /dynamicRegisterLoad definition lowering is unsupported/
  );
});

type RecordedOp =
  | Readonly<{ kind: "drop" }>
  | Readonly<{ kind: "tee"; local: number }>
  | Readonly<{ kind: "get"; local: number }>
  | Readonly<{ kind: "alloc"; local: number; type: WasmValueType }>
  | Readonly<{ kind: "free"; local: number }>;

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly events: RecordedOp[] = [];

  override drop(): this {
    super.drop();
    this.events.push({ kind: "drop" });
    return this;
  }

  override localTee(index: number): this {
    super.localTee(index);
    this.events.push({ kind: "tee", local: index });
    return this;
  }

  override localGet(index: number): this {
    super.localGet(index);
    this.events.push({ kind: "get", local: index });
    return this;
  }

  override addLocal(type: WasmValueType): number {
    const local = super.addLocal(type);

    this.events.push({ kind: "alloc", local, type });
    return local;
  }
}

class RecordingScratch extends WasmLocalScratchAllocator {
  readonly #body: RecordingBody;

  constructor(body: RecordingBody) {
    super(body);
    this.#body = body;
  }

  override freeLocal(index: number): void {
    super.freeLocal(index);
    this.#body.events.push({ kind: "free", local: index });
  }
}

function memoryLoadDefinition(id: number, width: 8 | 16 | 32): BlockDefinition {
  const definition = definitionId(id);

  return Object.freeze({
    kind: "memoryLoad",
    id: definition,
    at: opSite(0),
    result: Object.freeze({ kind: "def", id: definition }),
    address: exprConst(0),
    width
  } satisfies BlockDefinition);
}

function definitionMetadata(definition: BlockDefinition): DefinitionResult {
  const site = definitionSite(definition);

  switch (definition.kind) {
    case "memoryLoad":
      return Object.freeze({
        id: definition.id,
        site,
        result: definitionExpr(definition.result),
        domain: "memory",
        inputExpr: definition.address,
        point: programPoint(site.at)
      } satisfies DefinitionResult);
    case "dynamicRegisterLoad":
      return Object.freeze({
        id: definition.id,
        site,
        result: definitionExpr(definition.result),
        domain: "registers",
        inputExpr: definition.index,
        point: programPoint(site.at)
      } satisfies DefinitionResult);
  }
}

function definitionSite(definition: BlockDefinition): BlockDefinitionSite {
  return Object.freeze({
    kind: "definition",
    at: placement(0),
    definition
  });
}

function definitionRecipe(definition: BlockDefinitionId, input: ExprRecipe): ExprRecipe {
  return Object.freeze({
    kind: "definition",
    definition,
    input
  });
}

function exprRecipe(value: number): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr: exprConst(value),
    children: Object.freeze([])
  });
}

function recipeValues(recipes: readonly ExprRecipe[]): Pick<ValuePlan, "recipes"> {
  return {
    recipes: Object.freeze({
      recipeForNeed: () => undefined,
      recipeIdForNeed: () => undefined,
      recipeId: (recipe) => recipeIndex(recipes, recipe),
      recipe: (id) => recipes[id] ?? fail(`unknown recipe ${id}`)
    } satisfies RecipeRegistry)
  };
}

function recipeIndex(recipes: readonly ExprRecipe[], recipe: ExprRecipe): ExprRecipeId | undefined {
  const index = recipes.findIndex((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(recipe)
  );

  return index < 0 ? undefined : index as ExprRecipeId;
}

function cachePlan(entries: readonly WasmCacheEntry[]): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze([...entries])
  });
}

function cacheEntry(id: number, recipe: ExprRecipe): WasmCacheEntry {
  return Object.freeze({
    id: id as WasmCacheEntryId,
    recipe,
    reasons: Object.freeze([]),
    uses: Object.freeze([])
  });
}

function region(id: number): LayoutRegion {
  return Object.freeze({
    id: id as LayoutRegionId,
    path: Object.freeze({ kind: "main" }),
    steps: Object.freeze([])
  });
}

function programPoint(at: Placement): ProgramPoint {
  return Object.freeze({
    path: Object.freeze({ kind: "main" }),
    at,
    phase: "at"
  } satisfies ProgramPoint);
}

function placement(opIndex: number): Placement {
  return Object.freeze({ opIndex, epoch: 0 });
}

function definitionId(id: number): BlockDefinitionId {
  return id as BlockDefinitionId;
}

function fail(message: string): never {
  throw new Error(message);
}
