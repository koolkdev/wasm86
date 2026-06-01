import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  analyzeBarrierFacts,
  barriersCrossedBeforeUse,
  blockingBarrierForDefinitionReplay,
  buildTimelineGeometry,
  type BarrierFacts
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import type { BlockTimelineSite } from "#ir/block/timeline.js";
import {
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("memoryStore creates a memory-write barrier effect after its inputs", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    }
  ]);
  const store = geometry.memory.writes[0]!;
  const points = geometry.points.bySite.get(store.site)!;

  strictEqual(facts.barriers.length, 1);
  deepStrictEqual(facts.barriers[0], {
    kind: "memory-write",
    site: store.site,
    inputPoint: points.at,
    effectPoint: points.after
  });
});

test("dynamicRegisterStore creates a dynamic-register-store barrier effect after its inputs", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x55),
      accessWidth: 32
    }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(3), 32)]
    })
  });
  const store = geometry.registers.dynamicStores[0]!;
  const points = geometry.points.bySite.get(store.site)!;

  strictEqual(facts.barriers.length, 1);
  deepStrictEqual(facts.barriers[0], {
    kind: "dynamic-register-store",
    site: store.site,
    inputPoint: points.at,
    effectPoint: points.after
  });
});

test("memoryLoad creates a memory-domain definition result with address input", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    }
  ]);
  const definition = geometry.definitions.points[0]!;

  deepStrictEqual(facts.definitions, [{
    id: definition.definition.id,
    site: definition.site,
    result: exprInput({ kind: "def", id: definition.definition.id }),
    domain: "memory",
    inputExpr: exprConst(0x1000),
    point: definition.point
  }]);
});

test("dynamicRegisterLoad creates a registers-domain definition result with index input", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "operand", index: 0 },
      accessWidth: 32
    }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(7), 32)]
    })
  });
  const definition = geometry.definitions.points[0]!;

  deepStrictEqual(facts.definitions, [{
    id: definition.definition.id,
    site: definition.site,
    result: exprInput({ kind: "def", id: definition.definition.id }),
    domain: "registers",
    inputExpr: exprConst(7),
    point: definition.point
  }]);
});

test("blockingBarrierForDefinitionReplay skips non-matching barriers and finds the first matching crossed barrier", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(1),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x2000) },
      value: c(2),
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: c(0x3000) },
      value: c(3),
      accessWidth: 32
    },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const definition = facts.definitions[0]!;
  const usePoint = geometry.points.bySite.get(fallthroughSite(geometry.points.bySite.keys()))!.at;

  deepStrictEqual(
    barriersCrossedBeforeUse(facts, definition.point, usePoint).map((barrier) => barrier.kind),
    ["dynamic-register-store", "memory-write", "memory-write"]
  );
  strictEqual(blockingBarrierForDefinitionReplay(facts, definition, usePoint), facts.barriers[1]);
});

test("memoryStore barrier does not block definitions used by that store's inputs", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "mem", address: v(0) },
      value: v(0),
      accessWidth: 32
    }
  ]);
  const definition = facts.definitions[0]!;
  const store = geometry.memory.writes[0]!;

  deepStrictEqual(store.site.action.address, definition.result);
  deepStrictEqual(store.site.action.value, definition.result);
  deepStrictEqual(barriersCrossedBeforeUse(facts, definition.point, store.point), []);
  strictEqual(blockingBarrierForDefinitionReplay(facts, definition, store.point), undefined);
});

test("dynamicRegisterStore barrier does not block definitions used by that store's inputs", () => {
  const firstDefinitionResult = exprInput({ kind: "def", id: 0 });
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "operand", index: 0 },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 1 },
      value: v(0),
      accessWidth: 32
    }
  ], {
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(3), 32),
        dynamicRegBinding(firstDefinitionResult, 32)
      ]
    })
  });
  const definition = facts.definitions[0]!;
  const store = geometry.registers.dynamicStores[0]!;

  deepStrictEqual(definition.result, firstDefinitionResult);
  deepStrictEqual(store.site.action.index, firstDefinitionResult);
  deepStrictEqual(store.site.action.value, firstDefinitionResult);
  deepStrictEqual(barriersCrossedBeforeUse(facts, definition.point, store.point), []);
  strictEqual(blockingBarrierForDefinitionReplay(facts, definition, store.point), undefined);
});

test("BarrierFacts exposes only barriers and definitions", () => {
  const { facts } = analyzeBlock([
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
  ]);

  deepStrictEqual(Object.keys(facts).sort(), ["barriers", "definitions"]);
  strictEqual(Object.hasOwn(facts, "NeedAvailability"), false);
  strictEqual(Object.hasOwn(facts, "ExprRecipe"), false);
  strictEqual(Object.hasOwn(facts, "SavedExpr"), false);
  strictEqual(Object.hasOwn(facts, "policy"), false);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  facts: BarrierFacts;
  geometry: ReturnType<typeof buildTimelineGeometry>;
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);

  return {
    facts: analyzeBarrierFacts({ walked, geometry }),
    geometry
  };
}

function fallthroughSite(sites: Iterable<BlockTimelineSite>): BlockTimelineSite {
  for (const site of sites) {
    if (site.kind === "action" && site.action.kind === "fallthrough") {
      return site;
    }
  }

  throw new Error("missing fallthrough site");
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
