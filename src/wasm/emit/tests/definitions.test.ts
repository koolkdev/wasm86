import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  definitionExpr,
  type BlockDefinition,
  type BlockDefinitionId
} from "#ir/block/definitions.js";
import { modRmSelector } from "#ir/block/modrm-selector.js";
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
import {
  stateOffset,
  wasmImport,
  wasmMemoryIndex
} from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import {
  wasmOpcode,
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { createWasmDefinitionRecipeEmitter } from "#wasm/emit/block/definitions.js";
import { createWasmValueCache } from "#wasm/emit/cache/locals/index.js";
import { wasmCacheLifetimeKeepTracker } from "#wasm/emit/cache/lifetime/index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan
} from "#wasm/emit/cache/plan/index.js";
import { createWasmRecipeEmitter } from "#wasm/emit/values/recipes.js";
import {
  createWasmSourceReader,
  type WasmSourceReader
} from "#wasm/emit/sources/storage.js";
import { stateRegisterBasePlacement } from "#wasm/emit/state/placement.js";
import { wasmI32 } from "#wasm/emit/values/types.js";
import { wasmBodyMemoryAccesses, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";

test("memory-load definition metadata is replayable without emitting by itself", () => {
  const body = new RecordingBody();
  const definition = memoryLoadDefinition(0, 8);
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)],
    sources: unusedSourceReader()
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
    scratch,
    lifetime: wasmCacheLifetimeKeepTracker
  });
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)],
    sources: unusedSourceReader()
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
      definitions: [definitionMetadata(definition)],
      sources: unusedSourceReader()
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

test("dynamic-register-load definition dispatches register sources by runtime ModRM selector", async () => {
  const state = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(state.buffer);
  const instance = await instantiateDynamicRegisterLoad(state);
  const load = readExportedFunction(instance, "load");

  view.setUint32(stateOffset.eax, 0x0102_0304, true);
  view.setUint32(stateOffset.ebx, 0x0506_0708, true);
  view.setUint32(stateOffset.edi, 0x090a_0b0c, true);

  strictEqual(load(0), 0x0102_0304);
  strictEqual(load(3), 0x0506_0708);
  strictEqual(load(7), 0x090a_0b0c);
  strictEqual(load(99), 0);
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
        inputExpr: definition.selector.expr,
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
    requiredSnapshots: Object.freeze([])
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

async function instantiateDynamicRegisterLoad(
  state: WebAssembly.Memory
): Promise<WebAssembly.Instance> {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(1);
  const definition = dynamicRegisterLoadDefinition(2);
  const definitions = createWasmDefinitionRecipeEmitter({
    body,
    definitions: [definitionMetadata(definition)],
    sources: stateRegisterSourceReader(body)
  });

  definitions.emitDefinition(
    definition.id,
    () => {
      body.localGet(0);
      return wasmI32(32);
    }
  );
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("load", functionIndex);

  return WebAssembly.instantiate(await WebAssembly.compile(module.encode()), {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: state
    }
  });
}

function dynamicRegisterLoadDefinition(id: number): BlockDefinition {
  const definition = definitionId(id);

  return Object.freeze({
    kind: "dynamicRegisterLoad",
    id: definition,
    at: opSite(0),
    result: Object.freeze({ kind: "def", id: definition }),
    selector: modRmSelector(exprConst(0)),
    width: 32
  } satisfies BlockDefinition);
}

function unusedSourceReader(): WasmSourceReader {
  return {
    emitInput: (source) => {
      ok(false, `unexpected source read ${source.kind}`);
      return wasmI32(32);
    },
    tryEmitRegisterAliasInput: (alias) => {
      ok(false, `unexpected register alias read ${alias.name}`);
      return undefined;
    }
  };
}

function stateRegisterSourceReader(body: WasmFunctionBodyEncoder): WasmSourceReader {
  return createWasmSourceReader(body, {
    placement: (source) => {
      switch (source.kind) {
        case "reg":
          return { kind: "state.i32", state: stateRegisterBasePlacement(source.reg) };
        case "flag":
          ok(false, `unexpected flag source ${source.flag}`);
          return { kind: "packed-flag-local", local: 0 };
      }
    }
  });
}

function readExportedFunction(instance: WebAssembly.Instance, name: string): (index: number) => number {
  const value = instance.exports[name];

  ok(typeof value === "function", `expected exported function ${name}`);
  return value as (index: number) => number;
}

function fail(message: string): never {
  throw new Error(message);
}
