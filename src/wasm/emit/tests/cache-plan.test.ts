import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockDefinitionId } from "#ir/block/definitions.js";
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
  type LayoutStep,
  type SavedExpr,
  type SavedExprId,
  type ValuePlan
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprConst,
  exprInput,
  exprSelect
} from "#ir/expr/builders.js";
import { exprChildren } from "#ir/expr/children.js";
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
  type WasmCachePlan
} from "#wasm/emit/cache/plan/index.js";
import { recipeEmissionChildren } from "#wasm/emit/cache/plan/recipes.js";

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

  const preSaveIndex = main.steps.indexOf(memoryStores[0]!);

  strictEqual(preSaveIndex >= 0, true);
  strictEqual(saveIndex > preSaveIndex, true);
  deepStrictEqual(preSaveUse.recipe, {
    kind: "expr",
    expr: exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(4)),
    children: [
      {
        kind: "expr",
        expr: exprInput({ kind: "reg", reg: "eax" }),
        children: []
      },
      {
        kind: "expr",
        expr: exprConst(4),
        children: []
      }
    ]
  });
  deepStrictEqual(entry.uses, [preSaveUse.id, laterSavedUse.id]);
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
  const nestedAdd = exprRecipe(exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1)));
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
  const nestedInput = exprRecipe(exprInput({ kind: "reg", reg: "eax" }));
  const plan = planWasmCache({ layout, values });

  deepStrictEqual(values.savedExprs, []);
  strictEqual(entryForRecipe(plan, values, nestedInput), undefined);
});

test("Wasm cache plan can select duplicate child expressions", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: v(0) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 }
  ]);
  const inputRecipe = exprRecipe(exprInput({ kind: "reg", reg: "eax" }));
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

  deepStrictEqual(entry.recipe, inputRecipe);
  deepStrictEqual(entry.reasons.map((reason) => reason.kind), ["reuse"]);
});

test("Wasm cache plan can select parent and child recipes independently", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: v(0) },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1004) }, value: v(1), accessWidth: 32 }
  ]);
  const inputRecipe = exprRecipe(exprInput({ kind: "reg", reg: "eax" }));
  const parentRecipe = exprRecipe(exprBinary(
    "add",
    exprInput({ kind: "reg", reg: "eax" }),
    exprInput({ kind: "reg", reg: "eax" })
  ));
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
  const inputEntry = entryForRecipe(plan, values, inputRecipe) ?? fail("missing selected input recipe");
  const parentEntry = entryForRecipe(plan, values, parentRecipe) ?? fail("missing selected parent recipe");

  deepStrictEqual(parentEntry.reasons.map((reason) => reason.kind), ["reuse"]);
  deepStrictEqual(inputEntry.reasons.map((reason) => reason.kind), ["reuse"]);
});

test("Wasm recipe emission maps duplicated select child expressions by semantic slot", () => {
  const definition = 0 as BlockDefinitionId;
  const saved = 0 as SavedExprId;
  const duplicatedInput = exprInput({ kind: "def", id: definition });
  const whenFalseExpr = exprConst(0);
  const conditionRecipe = Object.freeze({
    kind: "definition",
    definition,
    input: exprRecipe(exprInput({ kind: "reg", reg: "eax" }))
  } satisfies ExprRecipe);
  const whenTrueRecipe = Object.freeze({ kind: "saved-expr", saved } satisfies ExprRecipe);
  const whenFalseRecipe = exprRecipe(whenFalseExpr);
  const selectRecipe = Object.freeze({
    kind: "expr",
    expr: exprSelect(duplicatedInput, duplicatedInput, whenFalseExpr),
    children: Object.freeze([
      conditionRecipe,
      whenTrueRecipe,
      whenFalseRecipe
    ])
  } satisfies ExprRecipe);

  deepStrictEqual(recipeEmissionChildren(selectRecipe), [
    whenTrueRecipe,
    whenFalseRecipe,
    conditionRecipe
  ]);
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

test("Wasm cache plan selects repeated address recipes", () => {
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

  strictEqual(plan.entries.length, 5);
  deepStrictEqual(plan.entries.map((entry) => entry.uses.length), [2, 2, 2, 2, 2]);
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

  deepStrictEqual(Object.keys(plan), ["entries"]);
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

function exprRecipe(expr: ExprRef): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze(exprChildren(expr).map(exprRecipe))
  } satisfies ExprRecipe);
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
