import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import { modRmSelector } from "#ir/block/modrm-selector.js";
import {
  analyzeBarrierFacts,
  blockingBarrierForDefinitionReplay,
  buildTimelineGeometry,
  latestBlockingBarrierBeforeStateWrite,
  type BarrierFacts
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
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
import { registerAlias } from "#x86/registers.js";

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
      operands: [dynamicRegBinding(modRmSelector(exprConst(3)), 32)]
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

test("dynamicRegisterLoad creates a registers-domain definition result with selector input", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "operand", index: 0 },
      accessWidth: 32
    }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(modRmSelector(exprConst(7)), 32)]
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
      operands: [dynamicRegBinding(modRmSelector(exprConst(4)), 32)]
    })
  });
  const definition = facts.definitions[0]!;
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(
    blockingBarrierForDefinitionReplay(facts, definition, fallthrough.point),
    facts.barriers[1]
  );
});

test("blockingBarrierForDefinitionReplay blocks register definitions across dynamic-register-store barriers", () => {
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
      value: c(1),
      accessWidth: 32
    },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(modRmSelector(exprConst(3)), 32),
        dynamicRegBinding(modRmSelector(exprConst(4)), 32)
      ]
    })
  });
  const definition = facts.definitions[0]!;
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(
    blockingBarrierForDefinitionReplay(facts, definition, fallthrough.point),
    facts.barriers[0]
  );
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
        dynamicRegBinding(modRmSelector(exprConst(3)), 32),
        dynamicRegBinding(modRmSelector(firstDefinitionResult), 32)
      ]
    })
  });
  const definition = facts.definitions[0]!;
  const store = geometry.registers.dynamicStores[0]!;

  deepStrictEqual(definition.result, firstDefinitionResult);
  deepStrictEqual(store.site.action.selector.expr, firstDefinitionResult);
  deepStrictEqual(store.site.action.value, firstDefinitionResult);
  strictEqual(blockingBarrierForDefinitionReplay(facts, definition, store.point), undefined);
});

test("latestBlockingBarrierBeforeStateWrite blocks register writes across dynamic-register-store barriers", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "set",
      target: { kind: "operand", index: 0 },
      value: c(0x55),
      accessWidth: 32
    },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(modRmSelector(exprConst(3)), 32)]
    })
  });
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "reg", reg: registerAlias("eax") },
      fallthrough.point
    ),
    facts.barriers[0]
  );
  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "flag", flag: "CF" },
      fallthrough.point
    ),
    undefined
  );
});

test("latestBlockingBarrierBeforeStateWrite returns the newest matching blocker before a write point", () => {
  const { facts, geometry } = analyzeBlock([
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
    },
    {
      op: "set",
      target: { kind: "operand", index: 1 },
      value: c(0x33),
      accessWidth: 32
    },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(modRmSelector(exprConst(3)), 32),
        dynamicRegBinding(modRmSelector(exprConst(4)), 32)
      ]
    })
  });
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "reg", reg: registerAlias("eax") },
      fallthrough.point
    ),
    facts.barriers[2]
  );
  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "flag", flag: "CF" },
      fallthrough.point
    ),
    undefined
  );
});

test("latestBlockingBarrierBeforeStateWrite does not treat memory writes as StateTarget blockers", () => {
  const { facts, geometry } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    },
    { op: "next" }
  ]);
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "reg", reg: registerAlias("eax") },
      fallthrough.point
    ),
    undefined
  );
  strictEqual(
    latestBlockingBarrierBeforeStateWrite(
      facts,
      { kind: "flag", flag: "CF" },
      fallthrough.point
    ),
    undefined
  );
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
  strictEqual(Object.hasOwn(facts, "ValueSnapshot"), false);
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

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
