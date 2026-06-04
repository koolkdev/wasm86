import {
  deepStrictEqual,
  notStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  analyzeBarrierFacts,
  analyzeValuePlan,
  buildTimelineGeometry,
  type ExprNeed,
  type ExprNeedId,
  type ExprRecipe,
  type SavedExprId,
  type StateObligationId,
  type ValuePlan
} from "#ir/block/planning/index.js";
import { MutableRecipeRegistry } from "#ir/block/planning/values/recipes.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import { buildExprGraph } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("ValuePlan maps constants and valid source inputs to inline recipes", () => {
  const { geometry, plan } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1004) },
      value: v(0),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, exprConst(0x55), geometry.memory.writes[0]!.point),
    need(1, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);

  deepStrictEqual(recipe(plan, 0), {
    kind: "inline",
    expr: exprConst(0x55)
  });
  deepStrictEqual(recipe(plan, 1), {
    kind: "inline",
    expr: exprInput({ kind: "reg", reg: "eax" })
  });
  strictEqual(plan.savedExprs.length, 0);
  strictEqual(geometry.memory.writes.length, 2);
});

test("ValuePlan saves a source input that crosses a dynamic-register barrier", () => {
  const { geometry, plan } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: v(0),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const saved = plan.savedExprs[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "saved-expr",
    saved: saved.id
  });
  deepStrictEqual(saved.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(saved.saveAt, dynamicStore.point);
  deepStrictEqual(saved.recipe, {
    kind: "inline",
    expr: exprInput({ kind: "reg", reg: "eax" })
  });
  deepStrictEqual(saved.usedByTopLevelNeeds, [id(0)]);
  strictEqual(saved.reason.kind, "source-read-barrier");
});

test("ValuePlan creates a definition recipe when replay is legal", () => {
  const { plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: v(0),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ]);
  const definition = facts.definitions[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "definition",
    definition: definition.id,
    input: {
      kind: "inline",
      expr: exprConst(0x1000)
    }
  });
  strictEqual(plan.savedExprs.length, 0);
});

test("ValuePlan saves input(def) after its definition and before a replay barrier", () => {
  const { geometry, plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: c(1),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x3000) },
      value: v(0),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);
  const definition = facts.definitions[0]!;
  const firstStore = geometry.memory.writes[0]!;
  const saved = plan.savedExprs[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "saved-expr",
    saved: saved.id
  });
  deepStrictEqual(saved.expr, exprInput({ kind: "def", id: definition.id }));
  strictEqual(saved.saveAt, firstStore.point);
  deepStrictEqual(saved.recipe, {
    kind: "definition",
    definition: definition.id,
    input: {
      kind: "inline",
      expr: exprConst(0x1000)
    }
  });
  deepStrictEqual(saved.usedByTopLevelNeeds, [id(0)]);
  strictEqual(saved.reason.kind, "definition-replay-barrier");
});

test("ValuePlan carries an exported recipe for definition replay inputs", () => {
  const { geometry, plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: v(0) },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: v(1),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const definition = facts.definitions[0]!;
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const savedInput = plan.savedExprs[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "definition",
    definition: definition.id,
    input: {
      kind: "saved-expr",
      saved: savedInput.id
    }
  });
  deepStrictEqual(savedInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(savedInput.saveAt, dynamicStore.point);
});

test("ValuePlan computes from a saved child instead of saving a parent composite", () => {
  const { geometry, plan } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c(4)
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: v(1),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const savedInput = plan.savedExprs[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "compute",
    expr: exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(4)),
    children: [
      {
        kind: "saved-expr",
        saved: savedInput.id
      },
      {
        kind: "inline",
        expr: exprConst(4)
      }
    ]
  });
  deepStrictEqual(savedInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(savedInput.saveAt, dynamicStore.point);
  deepStrictEqual(savedInput.recipe, {
    kind: "inline",
    expr: exprInput({ kind: "reg", reg: "eax" })
  });
});

test("ValuePlan computes a mixed-time expression from saved and definition child recipes", () => {
  const { geometry, plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(2),
      a: v(0),
      b: v(1)
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: v(2),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const definition = facts.definitions[0]!;
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const topRecipe = recipe(plan, 0);
  const savedInput = plan.savedExprs[0]!;
  const equivalentTopRecipe = Object.freeze({
    kind: "compute",
    expr: exprBinary(
      "add",
      exprInput({ kind: "reg", reg: "eax" }),
      exprInput({ kind: "def", id: definition.id })
    ),
    children: Object.freeze([
      Object.freeze({
        kind: "saved-expr",
        saved: savedInput.id
      } satisfies ExprRecipe),
      Object.freeze({
        kind: "definition",
        definition: definition.id,
        input: Object.freeze({
          kind: "inline",
          expr: exprConst(0x1000)
        } satisfies ExprRecipe)
      } satisfies ExprRecipe)
    ])
  } satisfies ExprRecipe);

  strictEqual(topRecipe.kind, "compute");
  deepStrictEqual(topRecipe.expr, exprBinary(
    "add",
    exprInput({ kind: "reg", reg: "eax" }),
    exprInput({ kind: "def", id: definition.id })
  ));
  deepStrictEqual(topRecipe.children, [
    {
      kind: "saved-expr",
      saved: savedInput.id
    },
    {
      kind: "definition",
      definition: definition.id,
      input: {
        kind: "inline",
        expr: exprConst(0x1000)
      }
    }
  ]);
  deepStrictEqual(savedInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(savedInput.saveAt, dynamicStore.point);
  strictEqual(plan.recipes.recipeId(equivalentTopRecipe), recipeId(plan, 0));
});

test("ValuePlan reuses saved expressions only for semantic availability", () => {
  const { plan } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c(1)
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: v(1),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1004) },
      value: v(1),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point),
    need(1, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);

  strictEqual(plan.savedExprs.length, 0);
  strictEqual(recipe(plan, 0).kind, "inline");
  strictEqual(recipe(plan, 1).kind, "inline");
});

test("ValuePlan saved-expression usage tracks all top-level needs", () => {
  const { geometry, plan } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: v(0),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1004) },
      value: v(0),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point),
    need(1, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const saved = plan.savedExprs[0]!;

  strictEqual(plan.savedExprs.length, 1);
  strictEqual(saved.saveAt, dynamicStore.point);
  deepStrictEqual(saved.usedByTopLevelNeeds, [id(0), id(1)]);
  deepStrictEqual(recipe(plan, 0), { kind: "saved-expr", saved: saved.id });
  deepStrictEqual(recipe(plan, 1), { kind: "saved-expr", saved: saved.id });
});

test("ValuePlan uses expression graph identity for saved-expression reuse", () => {
  const { plan } = analyzeBlock([
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x22),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, exprInput({ kind: "reg", reg: "eax" }), geometry.memory.writes[0]!.point),
    need(1, exprInput({ kind: "reg", reg: "eax" }), geometry.memory.writes[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const saved = plan.savedExprs[0]!;

  strictEqual(plan.savedExprs.length, 1);
  deepStrictEqual(saved.usedByTopLevelNeeds, [id(0), id(1)]);
  deepStrictEqual(recipe(plan, 0), { kind: "saved-expr", saved: saved.id });
  deepStrictEqual(recipe(plan, 1), { kind: "saved-expr", saved: saved.id });
});

test("ValuePlan assigns the same recipe id to structurally equivalent inline recipes", () => {
  const { plan } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x11),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, exprBinary("add", exprConst(1), exprConst(2)), geometry.memory.writes[0]!.point),
    need(1, exprBinary("add", exprConst(1), exprConst(2)), geometry.memory.writes[0]!.point)
  ]);

  strictEqual(recipeId(plan, 0), recipeId(plan, 1));
  strictEqual(
    plan.recipes.recipeId({
      kind: "inline",
      expr: exprBinary("add", exprConst(1), exprConst(2))
    }),
    recipeId(plan, 0)
  );
});

test("MutableRecipeRegistry treats compute children as authoritative", () => {
  const expr = exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1));
  const fromInline = {
    kind: "compute",
    expr,
    children: [
      { kind: "inline", expr: exprInput({ kind: "reg", reg: "eax" }) },
      { kind: "inline", expr: exprConst(1) }
    ]
  } satisfies ExprRecipe;
  const fromSaved = {
    kind: "compute",
    expr,
    children: [
      { kind: "saved-expr", saved: 0 as SavedExprId },
      { kind: "inline", expr: exprConst(1) }
    ]
  } satisfies ExprRecipe;
  const registry = new MutableRecipeRegistry(buildExprGraph([expr]));

  notStrictEqual(registry.recordRecipe(fromInline), registry.recordRecipe(fromSaved));
});

test("ValuePlan applies root-path barriers to branch-path expression needs", () => {
  const { geometry, plan } = analyzeBlock([
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x11),
      accessWidth: 32
    },
    {
      op: "conditionalJump",
      condition: c(1),
      taken: c(0x40),
      notTaken: c(0x44)
    }
  ], ({ geometry }) => [
    need(0, exprInput({ kind: "reg", reg: "eax" }), geometry.exits.points[0]!.point)
  ], {
    resolver: dynamicResolver()
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const saved = plan.savedExprs[0]!;

  strictEqual(plan.savedExprs.length, 1);
  strictEqual(saved.saveAt, dynamicStore.point);
  deepStrictEqual(recipe(plan, 0), { kind: "saved-expr", saved: saved.id });
});

test("ValuePlan exposes no carried-input planning API on its output", () => {
  const { plan } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[0]!.site.action.value, geometry.memory.writes[0]!.point)
  ]);

  deepStrictEqual(Object.keys(plan).sort(), ["recipes", "savedExprs"]);
  strictEqual(Object.hasOwn(plan, "SavedInput"), false);
  strictEqual(Object.hasOwn(plan, "InputLeafUse"), false);
  strictEqual(Object.hasOwn(plan, "carried"), false);
});

function analyzeBlock(
  block: IrBlock,
  makeNeeds: (input: Readonly<{
    geometry: ReturnType<typeof buildTimelineGeometry>;
    facts: ReturnType<typeof analyzeBarrierFacts>;
  }>) => readonly ExprNeed[],
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  geometry: ReturnType<typeof buildTimelineGeometry>;
  facts: ReturnType<typeof analyzeBarrierFacts>;
  plan: ValuePlan;
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const facts = analyzeBarrierFacts({ walked, geometry });
  const needs = Object.freeze([...makeNeeds({ geometry, facts })]);

  return {
    geometry,
    facts,
    plan: analyzeValuePlan({ needs, geometry, facts })
  };
}

function recipe(plan: ValuePlan, value: number): ExprRecipe {
  const found = plan.recipes.recipeForNeed(id(value));

  if (found === undefined) {
    throw new Error(`missing recipe for need ${value}`);
  }

  return found;
}

function recipeId(plan: ValuePlan, value: number): NonNullable<ReturnType<ValuePlan["recipes"]["recipeId"]>> {
  const found = plan.recipes.recipeIdForNeed(id(value));

  if (found === undefined) {
    throw new Error(`missing recipe id for need ${value}`);
  }

  return found;
}

function need(value: number, expr: ExprRef, point: ExprNeed["point"]): ExprNeed {
  return Object.freeze({
    id: id(value),
    expr,
    point,
    origin: Object.freeze({
      kind: "state-obligation-value",
      obligation: id(value) as unknown as StateObligationId
    })
  } satisfies ExprNeed);
}

function id(value: number): ExprNeedId {
  return value as ExprNeedId;
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
