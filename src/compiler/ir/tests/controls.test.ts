import {
  deepStrictEqual,
  notStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  Invocation
} from "#compiler/ir/invocation.js";
import {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl
} from "#compiler/ir/controls/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import { CellRef } from "#compiler/ir/cell.js";
import type { Region } from "#compiler/ir/region.js";

test("if controls expose their condition, outputs, and nested bodies", () => {
  const values = new ValueTable();
  const condition = values.parameter(0, "i32");
  const output = values.addNodeOutput();
  const thenBody: Region = { nodes: [], result: values.const(1) };
  const elseBody: Region = { nodes: [], result: values.const(0) };
  const branch = ifControl.create({
    condition,
    output,
    thenBody,
    elseBody,
    hint: "likely"
  });

  deepStrictEqual(branch.operands, [condition]);
  deepStrictEqual(branch.outputs, [output]);
  strictEqual(branch.hint, "likely");
  deepStrictEqual(branch.nestedBodies, [
    {
      body: thenBody,
      role: "thenBody",
      scope: { kind: "ordinary" }
    },
    {
      body: elseBody,
      role: "elseBody",
      scope: { kind: "ordinary" }
    }
  ]);
});

test("loops expose carried values and their loop-scoped body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();
  const update = values.binary("add", loopInput, values.const(1));
  const body: Region = {
    nodes: [loopContinueControl.create({ updates: [update] })]
  };
  const loop = loopControl.create({
    carried: [{ seed, loopInput }],
    body
  });

  deepStrictEqual(loop.operands, [seed]);
  deepStrictEqual(loop.nestedBodies, [{
    body,
    role: "body",
    scope: { kind: "loop", inputs: [loopInput] }
  }]);
  deepStrictEqual(body.nodes[0]?.operands, [update]);
});

test("control-only switches share one body across all matches", () => {
  const values = new ValueTable();
  const selector = values.parameter(0, "i32");
  const selected: Region = { nodes: [] };
  const fallback: Region = { nodes: [] };
  const selection = switchControl.create({
    selector,
    cases: [{ matches: [1, 3, 5], body: selected }],
    defaultBody: fallback
  });

  deepStrictEqual(selection.operands, [selector]);
  deepStrictEqual(selection.outputs, []);
  deepStrictEqual(selection.cases, [{
    matches: [1, 3, 5],
    body: selected
  }]);
  deepStrictEqual(
    selection.nestedBodies.map((entry) => entry.body),
    [selected, fallback]
  );
});

test("body mapping replaces owned bodies without changing switch matches", () => {
  const values = new ValueTable();
  const selected: Region = { nodes: [] };
  const fallback: Region = { nodes: [] };
  const replacement: Region = { nodes: [] };
  const selection = switchControl.create({
    selector: values.parameter(0, "i32"),
    cases: [{ matches: [2, 4], body: selected }],
    defaultBody: fallback
  });
  const mapped = selection.mapBodies(
    (body) => body === selected ? replacement : body
  );

  notStrictEqual(mapped, selection);
  strictEqual(mapped.cases[0]?.body, replacement);
  deepStrictEqual(mapped.cases[0]?.matches, [2, 4]);
  strictEqual(mapped.defaultBody, fallback);
});

test("structured controls complete only when every reachable arm completes", () => {
  const values = new ValueTable();
  const completed: Region = { nodes: [] };
  const incomplete: Region = { nodes: [] };
  const completion = {
    regionCompletes: (body: Region) => body === completed
  };

  strictEqual(ifControl.create({
    condition: values.const(1),
    thenBody: completed,
    elseBody: completed
  }).completes(completion), true);
  strictEqual(ifControl.create({
    condition: values.const(1),
    thenBody: completed,
    elseBody: incomplete
  }).completes(completion), false);
  strictEqual(switchControl.create({
    selector: values.const(0),
    cases: [{ matches: [0], body: completed }],
    defaultBody: completed
  }).completes(completion), true);
});

test("return controls snapshot their result list", () => {
  const values = new ValueTable();
  const first = values.const(1);
  const results = [first];
  const control = returnControl.create({
    source: { kind: "values", values: results }
  });

  results.push(values.const(2));
  deepStrictEqual(control.operands, [first]);
});

test("invocation returns expose their argument and callee effects", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const cell = new CellRef("i32");
  const target = new FunctionDefinition({
    ref: functionRef("test.controls.target"),
    type: functionType(["i32"], ["i32"]),
    effects: {
      reads: [{ space: "cell", cell }],
      writes: []
    },
    owner: undefined,
    build: () => {}
  });
  const invocation = Invocation.create({
    target,
    arguments: [{ value: argument, type: "i32" }]
  });
  const returned = returnControl.create({
    source: { kind: "invocation", invocation }
  });

  deepStrictEqual(returned.operands, [argument]);
  deepStrictEqual(returned.directEffects, target.effects);
  strictEqual(returned.completes({ regionCompletes: () => false }), true);
});
