import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type {
  LayoutRegion,
  LayoutRegionId
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ExprRecipeId,
  RecipeRegistry,
  ValuePlan,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import {
  exprBits,
  exprInput,
  exprProject,
  exprUnary
} from "#ir/expr/builders.js";
import type {
  ExprRef,
  ScalarUnaryOp
} from "#ir/expr/types.js";
import { stateOffset, wasmMemoryIndex } from "#wasm/abi.js";
import {
  createWasmValueCache,
  type WasmValueCache
} from "#wasm/emit/cache/locals/index.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId,
  WasmCachePlan
} from "#wasm/emit/cache/plan/index.js";
import { stateRegisterBasePlacement } from "#wasm/emit/state/placement.js";
import {
  createWasmSourceReader,
  type WasmSourceReadPlacement
} from "#wasm/emit/sources/storage.js";
import {
  createWasmRecipeEmitter,
  type WasmDefinitionRecipeEmitter,
  type WasmRecipeEmitter
} from "#wasm/emit/values/recipes.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  wasmOpcode
} from "#wasm/encoder/types.js";
import {
  wasmBodyInstructions,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes
} from "#wasm/tests/body-opcodes.js";
import type {
  OperandWidth,
  Reg32
} from "#x86/types.js";

test("state-memory register input views emit direct canonical state loads", () => {
  const input = registerInputRecipe("eax");

  for (const entry of [
    {
      name: "input(eax)",
      recipe: input,
      access: { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
    },
    {
      name: "project8(input(eax))",
      recipe: projectRecipe(8, input),
      access: { opcode: wasmOpcode.i32Load8U, offset: stateOffset.eax }
    },
    {
      name: "bits(input(eax), 8, 8)",
      recipe: bitsRecipe(input, 8, 8),
      access: { opcode: wasmOpcode.i32Load8U, offset: stateOffset.eax + 1 }
    },
    {
      name: "project16(input(eax))",
      recipe: projectRecipe(16, input),
      access: { opcode: wasmOpcode.i32Load16U, offset: stateOffset.eax }
    },
    {
      name: "project32(input(eax))",
      recipe: projectRecipe(32, input),
      access: { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
    }
  ] as const) {
    const bytes = emitRecipe(entry.recipe);

    deepStrictEqual(stateAccesses(bytes), [entry.access], entry.name);
  }
});

test("local-backed register input views derive from the base local", () => {
  const input = registerInputRecipe("eax");
  const local = 7;

  for (const entry of [
    {
      name: "input(eax)",
      recipe: input,
      masked: false,
      signed: false
    },
    {
      name: "project8(input(eax))",
      recipe: projectRecipe(8, input),
      masked: true,
      signed: false
    },
    {
      name: "extend8_s(project8(input(eax)))",
      recipe: unaryRecipe("extend8_s", projectRecipe(8, input)),
      masked: true,
      signed: true
    },
    {
      name: "extend8_s(bits(input(eax), 8, 8))",
      recipe: unaryRecipe("extend8_s", bitsRecipe(input, 8, 8)),
      masked: true,
      shifted: true,
      signed: true
    },
    {
      name: "extend16_s(project16(input(eax)))",
      recipe: unaryRecipe("extend16_s", projectRecipe(16, input)),
      masked: true,
      signed16: true
    }
  ] as const) {
    const bytes = emitRecipe(entry.recipe, {
      placement: () => ({ kind: "local.i32", local })
    });
    const opcodes = wasmBodyOpcodes(bytes);

    deepStrictEqual(stateAccesses(bytes), [], entry.name);
    deepStrictEqual(
      wasmBodyInstructions(bytes)
        .filter((instruction) => instruction.opcode === wasmOpcode.localGet)
        .map((instruction) => instruction.local),
      [local],
      entry.name
    );
    strictEqual(opcodes.includes(wasmOpcode.i32And), entry.masked, entry.name);
    strictEqual(opcodes.includes(wasmOpcode.i32ShrU), entry.shifted === true, entry.name);
    strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), entry.signed === true, entry.name);
    strictEqual(opcodes.includes(wasmOpcode.i32Extend16S), entry.signed16 === true, entry.name);
  }
});

test("cache-visible register inputs are derived instead of narrowed state loads", () => {
  const input = registerInputRecipe("eax");
  const recipe = projectRecipe(8, input);
  const bytes = emitRecipe(recipe, {
    cacheEntries: [cacheEntry(0, input)]
  });
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.localTee), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), false);
});

test("snapshot children are not bypassed by direct state-register reads", () => {
  const input = registerInputRecipe("eax");
  const snapshot = snapshotId(1);
  const snapshotRecipe = Object.freeze({ kind: "snapshot", snapshot } satisfies ExprRecipe);
  const recipe = exprRecipeWithChildren(exprProject(8, input.expr), [snapshotRecipe]);
  const bytes = emitRecipe(recipe, {
    cacheEntries: [cacheEntry(0, input, [snapshot])],
    beforeEmit: (emitter) => emitter.establishSnapshot(snapshot, input)
  });
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.localSet), true);
  strictEqual(opcodes.includes(wasmOpcode.localGet), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), false);
});

test("signed extension over direct state-memory register views emits signed loads", () => {
  const input = registerInputRecipe("eax");

  for (const entry of [
    {
      name: "extend8_s(project8(input(eax)))",
      recipe: unaryRecipe("extend8_s", projectRecipe(8, input)),
      access: { opcode: wasmOpcode.i32Load8S, offset: stateOffset.eax }
    },
    {
      name: "extend8_s(bits(input(eax), 8, 8))",
      recipe: unaryRecipe("extend8_s", bitsRecipe(input, 8, 8)),
      access: { opcode: wasmOpcode.i32Load8S, offset: stateOffset.eax + 1 }
    },
    {
      name: "extend16_s(project16(input(eax)))",
      recipe: unaryRecipe("extend16_s", projectRecipe(16, input)),
      access: { opcode: wasmOpcode.i32Load16S, offset: stateOffset.eax }
    }
  ] as const) {
    const bytes = emitRecipe(entry.recipe);
    const opcodes = wasmBodyOpcodes(bytes);

    deepStrictEqual(stateAccesses(bytes), [entry.access], entry.name);
    strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), false, entry.name);
    strictEqual(opcodes.includes(wasmOpcode.i32Extend16S), false, entry.name);
  }
});

test("signed extension respects selected state-register view children", () => {
  const input = registerInputRecipe("eax");
  const project = projectRecipe(8, input);
  const recipe = unaryRecipe("extend8_s", project);
  const bytes = emitRecipe(recipe, {
    cacheEntries: [cacheEntry(0, project)]
  });
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load8U, offset: stateOffset.eax }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.localTee), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), false);
});

test("signed extension respects snapshot-backed register view children", () => {
  const input = registerInputRecipe("eax");
  const snapshot = snapshotId(2);
  const snapshotRecipe = Object.freeze({ kind: "snapshot", snapshot } satisfies ExprRecipe);
  const project = exprRecipeWithChildren(exprProject(8, input.expr), [snapshotRecipe]);
  const recipe = unaryRecipe("extend8_s", project);
  const bytes = emitRecipe(recipe, {
    cacheEntries: [cacheEntry(0, input, [snapshot])],
    beforeEmit: (emitter) => emitter.establishSnapshot(snapshot, input)
  });
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.localSet), true);
  strictEqual(opcodes.includes(wasmOpcode.localGet), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8S), false);
});

test("non-canonical register bit slices fall back to extraction", () => {
  const input = registerInputRecipe("eax");
  const bytes = emitRecipe(bitsRecipe(input, 16, 8));
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.i32ShrU), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), false);
});

test("non-aliased high-byte slices fall back to extraction", () => {
  const input = registerInputRecipe("esp");
  const bytes = emitRecipe(bitsRecipe(input, 8, 8));
  const opcodes = wasmBodyOpcodes(bytes);

  deepStrictEqual(stateAccesses(bytes), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.esp }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.i32ShrU), true);
  strictEqual(opcodes.includes(wasmOpcode.i32And), true);
  strictEqual(opcodes.includes(wasmOpcode.i32Load8U), false);
});

type ExprRecipeNode = Extract<ExprRecipe, { kind: "expr" }>;

type EmitRecipeOptions = Readonly<{
  cacheEntries?: readonly WasmCacheEntry[];
  placement?: (reg: Reg32) => WasmSourceReadPlacement;
  beforeEmit?: (emitter: WasmRecipeEmitter) => void;
}>;

function emitRecipe(recipe: ExprRecipe, options: EmitRecipeOptions = {}): Uint8Array<ArrayBuffer> {
  const body = new WasmFunctionBodyEncoder();
  const plan = cachePlan(options.cacheEntries ?? []);
  const { cache, emitter } = createFixture(body, plan, [recipe], options.placement);
  const main = region(0);

  cache.enterRegion(main);
  options.beforeEmit?.(emitter);
  emitter.emitRecipe(recipe);
  cache.leaveRegion(main);
  body.end();
  return body.encode();
}

function createFixture(
  body: WasmFunctionBodyEncoder,
  plan: WasmCachePlan,
  extraRecipes: readonly ExprRecipe[],
  placement: ((reg: Reg32) => WasmSourceReadPlacement) | undefined
): Readonly<{
  cache: WasmValueCache;
  emitter: WasmRecipeEmitter;
}> {
  const definitions: WasmDefinitionRecipeEmitter = {
    definitionInfo: () => undefined,
    emitDefinition: () => {
      throw new Error("unexpected definition recipe");
    }
  };
  const cache = createWasmValueCache({
    plan,
    values: recipeValues([...plan.entries.map((entry) => entry.recipe), ...extraRecipes]),
    body
  });
  const sources = createWasmSourceReader(body, {
    placement: (source) => {
      switch (source.kind) {
        case "reg":
          return placement?.(source.reg) ?? { kind: "state.i32", state: stateRegisterBasePlacement(source.reg) };
        case "flag":
          return { kind: "packed-flag-local", local: 31 };
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

function stateAccesses(bytes: Uint8Array<ArrayBuffer>): readonly Readonly<{ opcode: number; offset: number }>[] {
  return wasmBodyMemoryAccesses(bytes)
    .filter((access) => access.memoryIndex === wasmMemoryIndex.state)
    .map((access) => ({ opcode: access.opcode, offset: access.offset }));
}

function registerInputRecipe(reg: Reg32): ExprRecipeNode {
  return exprRecipeWithChildren(exprInput({ kind: "reg", reg }), []);
}

function projectRecipe(width: OperandWidth, child: ExprRecipeNode): ExprRecipeNode {
  return exprRecipeWithChildren(exprProject(width, child.expr), [child]);
}

function bitsRecipe(child: ExprRecipeNode, offset: number, width: OperandWidth): ExprRecipeNode {
  return exprRecipeWithChildren(exprBits(child.expr, offset, width), [child]);
}

function unaryRecipe(op: ScalarUnaryOp, child: ExprRecipeNode): ExprRecipeNode {
  return exprRecipeWithChildren(exprUnary(op, child.expr), [child]);
}

function exprRecipeWithChildren(expr: ExprRef, children: readonly ExprRecipe[]): ExprRecipeNode {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze([...children])
  } satisfies ExprRecipeNode);
}

function cachePlan(entries: readonly WasmCacheEntry[]): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze([...entries])
  } satisfies WasmCachePlan);
}

function cacheEntry(
  id: number,
  recipe: ExprRecipe,
  requiredSnapshots: readonly ValueSnapshotId[] = []
): WasmCacheEntry {
  return Object.freeze({
    id: id as WasmCacheEntryId,
    recipe,
    requiredSnapshots: Object.freeze([...requiredSnapshots])
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

function fail(message: string): never {
  throw new Error(message);
}
