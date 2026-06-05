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
  type ValueSnapshotId,
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
  exprInput,
  exprProject,
  exprUnary
} from "#ir/expr/builders.js";
import { buildExprGraph } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("ValuePlan maps constants and valid source inputs to expr recipes", () => {
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
    kind: "expr",
    expr: exprConst(0x55),
    children: []
  });
  deepStrictEqual(recipe(plan, 1), {
    kind: "expr",
    expr: exprInput({ kind: "reg", reg: "eax" }),
    children: []
  });
  strictEqual(plan.snapshots.length, 0);
  strictEqual(geometry.memory.writes.length, 2);
});

test("ValuePlan snapshots a source input that crosses a dynamic-register barrier", () => {
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
  const snapshot = plan.snapshots[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "snapshot",
    snapshot: snapshot.id
  });
  deepStrictEqual(snapshot.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(snapshot.establishAt, dynamicStore.point);
  deepStrictEqual(snapshot.recipe, {
    kind: "expr",
    expr: exprInput({ kind: "reg", reg: "eax" }),
    children: []
  });
  deepStrictEqual(snapshot.usedByTopLevelNeeds, [id(0)]);
  strictEqual(snapshot.reason.kind, "source-read-barrier");
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
      kind: "expr",
      expr: exprConst(0x1000),
      children: []
    }
  });
  strictEqual(plan.snapshots.length, 0);
});

test("ValuePlan snapshots input(def) after its definition and before a replay barrier", () => {
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
  const snapshot = plan.snapshots[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "snapshot",
    snapshot: snapshot.id
  });
  deepStrictEqual(snapshot.expr, exprInput({ kind: "def", id: definition.id }));
  strictEqual(snapshot.establishAt, firstStore.point);
  deepStrictEqual(snapshot.recipe, {
    kind: "definition",
    definition: definition.id,
    input: {
      kind: "expr",
      expr: exprConst(0x1000),
      children: []
    }
  });
  deepStrictEqual(snapshot.usedByTopLevelNeeds, [id(0)]);
  strictEqual(snapshot.reason.kind, "definition-replay-barrier");
});

test("ValuePlan snapshots a barrier-crossing definition view chain", () => {
  const { geometry, plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 8
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: c(1),
      accessWidth: 32
    },
    {
      op: "value.unary",
      type: "i32",
      operator: "extend8_s",
      dst: v(1),
      value: v(0)
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x3000) },
      value: v(1),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);
  const definition = facts.definitions[0]!;
  const firstStore = geometry.memory.writes[0]!;
  const signedLoad = exprUnary("extend8_s", exprInput({ kind: "def", id: definition.id }));
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  deepStrictEqual(recipe(plan, 0), {
    kind: "snapshot",
    snapshot: snapshot.id
  });
  deepStrictEqual(snapshot.expr, signedLoad);
  strictEqual(snapshot.establishAt, firstStore.point);
  deepStrictEqual(snapshot.recipe, {
    kind: "expr",
    expr: signedLoad,
    children: [
      {
        kind: "definition",
        definition: definition.id,
        input: {
          kind: "expr",
          expr: exprConst(0x1000),
          children: []
        }
      }
    ]
  });
  deepStrictEqual(snapshot.usedByTopLevelNeeds, [id(0)]);
  strictEqual(snapshot.reason.kind, "definition-replay-barrier");
});

test("ValuePlan snapshots non-unary barrier view chains", () => {
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
      op: "value.project",
      type: "i32",
      dst: v(1),
      width: 8,
      value: v(0)
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x3000) },
      value: v(1),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);
  const definition = facts.definitions[0]!;
  const firstStore = geometry.memory.writes[0]!;
  const projectedLoad = exprProject(8, exprInput({ kind: "def", id: definition.id }));
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  deepStrictEqual(recipe(plan, 0), {
    kind: "snapshot",
    snapshot: snapshot.id
  });
  deepStrictEqual(snapshot.expr, projectedLoad);
  strictEqual(snapshot.establishAt, firstStore.point);
  deepStrictEqual(snapshot.recipe, {
    kind: "expr",
    expr: projectedLoad,
    children: [
      {
        kind: "definition",
        definition: definition.id,
        input: {
          kind: "expr",
          expr: exprConst(0x1000),
          children: []
        }
      }
    ]
  });
});

test("ValuePlan stops barrier view snapshots before multi-input parents", () => {
  const { plan, facts } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 8
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: c(1),
      accessWidth: 32
    },
    {
      op: "get",
      dst: v(1),
      source: { kind: "reg", reg: "ecx" },
      accessWidth: 32
    },
    {
      op: "value.unary",
      type: "i32",
      operator: "extend8_s",
      dst: v(2),
      value: v(0)
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(3),
      a: v(2),
      b: v(1)
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x3000) },
      value: v(3),
      accessWidth: 32
    }
  ], ({ geometry }) => [
    need(0, geometry.memory.writes[1]!.site.action.value, geometry.memory.writes[1]!.point)
  ]);
  const definition = facts.definitions[0]!;
  const signedLoad = exprUnary("extend8_s", exprInput({ kind: "def", id: definition.id }));
  const add = exprBinary("add", signedLoad, exprInput({ kind: "reg", reg: "ecx" }));
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  deepStrictEqual(snapshot.expr, signedLoad);
  deepStrictEqual(recipe(plan, 0), {
    kind: "expr",
    expr: add,
    children: [
      {
        kind: "snapshot",
        snapshot: snapshot.id
      },
      {
        kind: "expr",
        expr: exprInput({ kind: "reg", reg: "ecx" }),
        children: []
      }
    ]
  });
  deepStrictEqual(snapshot.recipe, {
    kind: "expr",
    expr: signedLoad,
    children: [
      {
        kind: "definition",
        definition: definition.id,
        input: {
          kind: "expr",
          expr: exprConst(0x1000),
          children: []
        }
      }
    ]
  });
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
  const snapshotInput = plan.snapshots[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "definition",
    definition: definition.id,
    input: {
      kind: "snapshot",
      snapshot: snapshotInput.id
    }
  });
  deepStrictEqual(snapshotInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(snapshotInput.establishAt, dynamicStore.point);
});

test("ValuePlan computes from a snapshot child instead of snapshotting a parent composite", () => {
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
  const snapshotInput = plan.snapshots[0]!;

  deepStrictEqual(recipe(plan, 0), {
    kind: "expr",
    expr: exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(4)),
    children: [
      {
        kind: "snapshot",
        snapshot: snapshotInput.id
      },
      {
        kind: "expr",
        expr: exprConst(4),
        children: []
      }
    ]
  });
  deepStrictEqual(snapshotInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(snapshotInput.establishAt, dynamicStore.point);
  deepStrictEqual(snapshotInput.recipe, {
    kind: "expr",
    expr: exprInput({ kind: "reg", reg: "eax" }),
    children: []
  });
});

test("ValuePlan computes a mixed-time expression from snapshot and definition child recipes", () => {
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
  const snapshotInput = plan.snapshots[0]!;
  const equivalentTopRecipe = Object.freeze({
    kind: "expr",
    expr: exprBinary(
      "add",
      exprInput({ kind: "reg", reg: "eax" }),
      exprInput({ kind: "def", id: definition.id })
    ),
    children: Object.freeze([
      Object.freeze({
        kind: "snapshot",
        snapshot: snapshotInput.id
      } satisfies ExprRecipe),
      Object.freeze({
        kind: "definition",
        definition: definition.id,
        input: Object.freeze({
          kind: "expr",
          expr: exprConst(0x1000),
          children: Object.freeze([])
        } satisfies ExprRecipe)
      } satisfies ExprRecipe)
    ])
  } satisfies ExprRecipe);

  strictEqual(topRecipe.kind, "expr");
  deepStrictEqual(topRecipe.expr, exprBinary(
    "add",
    exprInput({ kind: "reg", reg: "eax" }),
    exprInput({ kind: "def", id: definition.id })
  ));
  deepStrictEqual(topRecipe.children, [
    {
      kind: "snapshot",
      snapshot: snapshotInput.id
    },
    {
      kind: "definition",
      definition: definition.id,
      input: {
        kind: "expr",
        expr: exprConst(0x1000),
        children: []
      }
    }
  ]);
  deepStrictEqual(snapshotInput.expr, exprInput({ kind: "reg", reg: "eax" }));
  strictEqual(snapshotInput.establishAt, dynamicStore.point);
  strictEqual(plan.recipes.recipeId(equivalentTopRecipe), recipeId(plan, 0));
});

test("ValuePlan reuses snapshot expressions only for semantic availability", () => {
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

  strictEqual(plan.snapshots.length, 0);
  strictEqual(recipe(plan, 0).kind, "expr");
  strictEqual(recipe(plan, 1).kind, "expr");
});

test("ValuePlan snapshot usage tracks all top-level needs", () => {
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
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  strictEqual(snapshot.establishAt, dynamicStore.point);
  deepStrictEqual(snapshot.usedByTopLevelNeeds, [id(0), id(1)]);
  deepStrictEqual(recipe(plan, 0), { kind: "snapshot", snapshot: snapshot.id });
  deepStrictEqual(recipe(plan, 1), { kind: "snapshot", snapshot: snapshot.id });
});

test("ValuePlan uses expression graph identity for snapshot reuse", () => {
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
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  deepStrictEqual(snapshot.usedByTopLevelNeeds, [id(0), id(1)]);
  deepStrictEqual(recipe(plan, 0), { kind: "snapshot", snapshot: snapshot.id });
  deepStrictEqual(recipe(plan, 1), { kind: "snapshot", snapshot: snapshot.id });
});

test("ValuePlan assigns the same recipe id to structurally equivalent expr recipes", () => {
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
      kind: "expr",
      expr: exprBinary("add", exprConst(1), exprConst(2)),
      children: [
        { kind: "expr", expr: exprConst(1), children: [] },
        { kind: "expr", expr: exprConst(2), children: [] }
      ]
    }),
    recipeId(plan, 0)
  );
});

test("MutableRecipeRegistry treats expr children as authoritative", () => {
  const expr = exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1));
  const fromInline = {
    kind: "expr",
    expr,
    children: [
      { kind: "expr", expr: exprInput({ kind: "reg", reg: "eax" }), children: [] },
      { kind: "expr", expr: exprConst(1), children: [] }
    ]
  } satisfies ExprRecipe;
  const fromSnapshot = {
    kind: "expr",
    expr,
    children: [
      { kind: "snapshot", snapshot: 0 as ValueSnapshotId },
      { kind: "expr", expr: exprConst(1), children: [] }
    ]
  } satisfies ExprRecipe;
  const registry = new MutableRecipeRegistry(buildExprGraph([expr]));

  notStrictEqual(registry.recordRecipe(fromInline), registry.recordRecipe(fromSnapshot));
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
  const snapshot = plan.snapshots[0]!;

  strictEqual(plan.snapshots.length, 1);
  strictEqual(snapshot.establishAt, dynamicStore.point);
  deepStrictEqual(recipe(plan, 0), { kind: "snapshot", snapshot: snapshot.id });
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

  deepStrictEqual(Object.keys(plan).sort(), ["recipes", "snapshots"]);
  strictEqual(Object.hasOwn(plan, "ValueSnapshot"), false);
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
