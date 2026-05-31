import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import {
  type BlockDefinition
} from "#ir/block/definitions.js";
import {
  rootsForBlockSites,
  type BlockRoot
} from "#ir/block/roots.js";
import type {
  BlockTimeline,
  BlockTimelineSite
} from "#ir/block/timeline.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprConst,
  exprInput,
  exprUnary
} from "#ir/expr/builders.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("memory load definitions expose raw block-defined sources and signed uses stay explicit", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 8 },
      { op: "value.unary", type: "i32", operator: "extend8_s", dst: v(1), value: v(0) },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1), accessWidth: 32 }
    ]
  });
  const definition = onlyDefinition(result.timeline);

  strictEqual(definition.kind, "memoryLoad");
  strictEqual(definition.width, 8);
  deepStrictEqual(definition.result, { kind: "def", id: definition.id });
  strictEqual(Object.hasOwn(definition, "signed"), false);
  deepStrictEqual(
    result.final.registers.read("eax"),
    exprUnary("extend8_s", exprInput(definition.result))
  );
});

test("rootsForBlockSites projects memory roots and block-defined value observations", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 2, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 16 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 16 }
    ]
  });
  const roots = rootsForBlockSites({ timeline: result.timeline });
  const load = definitionEntry(result.timeline, "memoryLoad");
  const storeValue = actionRoot(roots, "memoryStore", "value");

  deepStrictEqual(actionRoot(roots, "memoryGuard", "address").expr, exprConst(0x1000));
  deepStrictEqual(definitionRoot(roots, "memoryLoad", "address").expr, exprConst(0x2000));
  deepStrictEqual(actionRoot(roots, "memoryStore", "address").expr, exprConst(0x3000));
  deepStrictEqual(storeValue.expr, exprInput(load.definition.result));
});

test("rootsForBlockSites projects dynamic register roots and producer indices", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(1), 32),
        dynamicRegBinding(exprConst(2), 32)
      ]
    })
  });
  const roots = rootsForBlockSites({ timeline: result.timeline });
  const load = definitionEntry(result.timeline, "dynamicRegisterLoad");

  deepStrictEqual(definitionRoot(roots, "dynamicRegisterLoad", "index").expr, exprConst(1));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "index").expr, exprConst(2));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "value").expr, exprInput(load.definition.result));
});

test("rootsForBlockSites projects branch, jump, fallthrough, and host trap roots", () => {
  const branch = rootsForBlockSites({ timeline: walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ],
    continuation: exprConst(0x48)
  }).timeline });
  const jump = rootsForBlockSites({ timeline: walkExpressionBlock({
    block: [
      { op: "jump", target: c(0x80) }
    ]
  }).timeline });
  const trap = rootsForBlockSites({ timeline: walkExpressionBlock({
    block: [
      { op: "hostTrap", vector: c(7) }
    ]
  }).timeline });
  const fallthrough = rootsForBlockSites({ timeline: walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  }).timeline });

  deepStrictEqual(actionRoot(branch, "branch", "condition").expr, exprConst(1));
  deepStrictEqual(
    [
      actionRoot(branch, "branch", "target", "taken").expr,
      actionRoot(branch, "branch", "target", "notTaken").expr
    ],
    [exprConst(0x40), exprConst(0x44)]
  );
  deepStrictEqual(actionRoot(jump, "jump", "target").expr, exprConst(0x80));
  deepStrictEqual(actionRoot(fallthrough, "fallthrough", "target").expr, exprConst(0x90));
  deepStrictEqual(actionRoot(trap, "hostTrap", "vector").expr, exprConst(7));
});

test("rootsForBlockSites does not project exit observation roots", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
      { op: "next" }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const roots = rootsForBlockSites({ timeline: result.timeline });

  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "index").expr, exprConst(4));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "value").expr, exprConst(0x55));
});

test("root projection remains block-owned and independent of target modules", () => {
  const source = readFileSync(new URL("../roots.js", import.meta.url), "utf8");

  strictEqual(source.includes("#backends/"), false);
  strictEqual(source.includes("interpreter"), false);
  strictEqual(source.includes("walkExpressionBlock"), false);
});

test("dynamic register state reset does not leak into expression identity", () => {
  const sources = [
    readFileSync(new URL("../../expr/types.js", import.meta.url), "utf8"),
    readFileSync(new URL("../../expr/graph/graph.js", import.meta.url), "utf8")
  ].join("\n");

  strictEqual(sources.includes("runtimeMask"), false);
  strictEqual(sources.includes("runtimeOwned"), false);
  strictEqual(sources.includes("runtimeBacked"), false);
  strictEqual(sources.includes("dynamicRegisterStore"), false);
});

function onlyDefinition(timeline: BlockTimeline): BlockDefinition {
  const definitions = timeline.flatMap((site) =>
    site.kind === "definition" ? [site.definition] : []
  );

  strictEqual(definitions.length, 1);
  return definitions[0]!;
}

function actionRoot(
  roots: readonly BlockRoot[],
  kind: BlockAction["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "actionInput" }>["input"],
  direction?: "taken" | "notTaken"
): BlockRoot {
  const root = roots.find((candidate) =>
    candidate.site.kind === "action" &&
      candidate.site.action.kind === kind &&
      candidate.purpose.kind === "actionInput" &&
      candidate.purpose.input === input &&
      candidate.purpose.direction === direction
  );

  if (root === undefined) {
    throw new Error(`missing ${kind} ${input} root`);
  }

  return root;
}

function definitionRoot<TKind extends BlockDefinition["kind"]>(
  roots: readonly BlockRoot[],
  kind: TKind,
  input: Extract<BlockRoot["purpose"], { kind: "definitionInput" }>["input"]
): BlockRoot {
  const root = roots.find((candidate) =>
    candidate.site.kind === "definition" &&
      candidate.site.definition.kind === kind &&
      candidate.purpose.kind === "definitionInput" &&
      candidate.purpose.input === input
  );

  if (root === undefined) {
    throw new Error(`missing ${kind} ${input} root`);
  }

  return root;
}

function definitionEntry<TKind extends BlockDefinition["kind"]>(
  timeline: BlockTimeline,
  kind: TKind
): Extract<BlockTimelineSite, { kind: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }> {
  const site = timeline.find((item) =>
    item.kind === "definition" && item.definition.kind === kind
  );

  if (site === undefined || site.kind !== "definition" || site.definition.kind !== kind) {
    throw new Error(`missing definition ${kind}`);
  }

  return site as Extract<BlockTimelineSite, { kind: "definition" }> &
    Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }>;
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
