import {
  deepStrictEqual,
  notStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { rootsForSchedule } from "#ir/block/roots.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import {
  exprBinary,
  exprBits,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject,
  exprSelect,
  exprUnary
} from "#ir/expr/builders.js";
import {
  buildExprGraph,
  buildExprGraphAnalysis
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("ExprGraph interns canonical equivalent expressions to one node", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);
  const equivalent = exprBits(exprInput({ kind: "reg", reg: "eax" }), 0, 8);
  const graph = buildExprGraph([projected, equivalent]);

  strictEqual(graph.node(projected), graph.node(equivalent));
});

test("ExprGraph gives different structural expressions different nodes", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const add = exprBinary("add", eax, exprConst(1));
  const sub = exprBinary("sub", eax, exprConst(1));
  const graph = buildExprGraph([add, sub]);

  notStrictEqual(graph.node(add), graph.node(sub));
});

test("ExprGraph closed lookup accepts covered equivalents and rejects new nodes", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);
  const graph = buildExprGraph([projected]);

  strictEqual(
    graph.node(exprBits(exprInput({ kind: "reg", reg: "eax" }), 0, 8)),
    graph.node(projected)
  );
  throws(
    () => graph.node(exprBinary("add", eax, exprConst(1))),
    /expression graph is closed/
  );
  throws(
    () => graph.get(100),
    /unknown expression graph node id/
  );
});

test("ExprGraph keeps block-defined value sources stable across BlockRoots", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
    ]
  });
  const roots = rootsForSchedule(result.schedule);
  const graph = buildExprGraph(roots.map((root) => root.expr));
  const definition = memoryLoadDefinition(result);
  const definitionExpr = exprInput(definition.result);
  const freshDefinitionExpr = exprInput({ kind: "def", id: definition.id });
  const rootExpr = roots.find((root) =>
    root.expr.kind === "input" &&
      root.expr.source.kind === "def" &&
      root.expr.source.id === definition.id
  )?.expr;

  if (rootExpr === undefined) {
    throw new Error("missing block-defined root expression");
  }

  strictEqual(graph.node(freshDefinitionExpr), graph.node(definitionExpr));
  strictEqual(graph.node(rootExpr), graph.node(definitionExpr));
});

test("ExprGraph child links are stable for every expression kind", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const zf = exprInput({ kind: "flag", flag: "ZF" });
  const leaf = exprConst(7);
  const cases: readonly Readonly<{ expr: ExprRef; children: readonly ExprRef[] }>[] = [
    { expr: exprBinary("xor", eax, ebx), children: [eax, ebx] },
    { expr: exprUnary("popcnt", eax), children: [eax] },
    { expr: exprSelect(zf, eax, ebx), children: [zf, eax, ebx] },
    { expr: exprProject(8, eax), children: [eax] },
    { expr: exprBits(eax, 8, 8), children: [eax] },
    { expr: exprInsertBits(eax, ebx, 8, 8), children: [eax, ebx] },
    { expr: exprCompare(16, "eq", eax, ebx), children: [eax, ebx] }
  ];
  const graph = buildExprGraph([leaf, zf, ...cases.map((entry) => entry.expr)]);

  deepStrictEqual(graph.node(leaf).children, []);
  deepStrictEqual(graph.node(zf).children, []);

  for (const valueCase of cases) {
    deepStrictEqual(
      graph.node(valueCase.expr).children.map((child) => child.id),
      valueCase.children.map((child) => graph.node(child).id)
    );
  }
});

test("ExprGraph analysis exposes topological order and identity", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const expr = exprBinary("xor", exprUnary("popcnt", eax), exprConst(3));
  const analysis = buildExprGraphAnalysis([expr]);
  const root = analysis.identity.node(expr);

  strictEqual(analysis.order.at(-1), root);

  for (const node of analysis.order) {
    for (const child of node.children) {
      strictEqual(child.id < node.id, true);
    }
  }
});

test("ExprGraph builds and traverses deep chains without recursive stack growth", () => {
  const depth = 12_000;
  const eax = exprInput({ kind: "reg", reg: "eax" });
  let expr = eax;

  for (let index = 0; index < depth; index += 1) {
    expr = exprUnary("popcnt", expr);
  }

  const graph = buildExprGraph([expr]);
  let node = graph.node(expr);
  let observedDepth = 0;

  while (node.children.length > 0) {
    node = node.children[0]!;
    observedDepth += 1;
  }

  strictEqual(observedDepth, depth);
  strictEqual(node, graph.node(eax));
});

function memoryLoadDefinition(
  result: ReturnType<typeof walkExpressionBlock>
): Extract<BlockDefinition, { kind: "memoryLoad" }> {
  const entry = result.schedule.find((item) =>
    item.role === "definition" && item.definition.kind === "memoryLoad"
  );

  if (entry === undefined || entry.role !== "definition" || entry.definition.kind !== "memoryLoad") {
    throw new Error("missing memory load definition");
  }

  return entry.definition;
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
