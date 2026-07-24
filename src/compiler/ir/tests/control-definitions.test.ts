import {
  deepStrictEqual,
  notStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  Invocation,
  invocationInputs
} from "#compiler/ir/invocation.js";
import {
  controlCompletes,
  ifControl,
  loopContinueControl,
  loopControl,
  mapControlBodies,
  returnControl,
  switchControl
} from "#compiler/ir/controls/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import { VariableRef } from "#compiler/ir/variable.js";
import type { Region } from "#compiler/ir/region.js";
import { describeNode } from "#compiler/ir/node.js";

test("if control definitions expose their condition, outputs, and nested bodies", () => {
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
  const description = describeNode(branch);

  deepStrictEqual(description.operands, [condition]);
  deepStrictEqual(description.outputs, [output]);
  strictEqual(branch.hint, "likely");
  deepStrictEqual(description.nestedBodies, [
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
  const description = describeNode(loop);

  deepStrictEqual(description.operands, [seed]);
  deepStrictEqual(description.nestedBodies, [{
    body,
    role: "body",
    scope: { kind: "loop", inputs: [loopInput] }
  }]);
  const continuation = body.nodes[0];

  strictEqual(continuation?.kind, "loopContinue");
  if (continuation !== undefined) {
    deepStrictEqual(describeNode(continuation).operands, [update]);
  }
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
  const description = describeNode(selection);

  deepStrictEqual(description.operands, [selector]);
  deepStrictEqual(description.outputs, []);
  deepStrictEqual(selection.cases, [{
    matches: [1, 3, 5],
    body: selected
  }]);
  deepStrictEqual(
    description.nestedBodies.map((entry) => entry.body),
    [selected, fallback]
  );
});

test("switch definitions reject duplicate and out-of-range matches", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const body: Region = { nodes: [] };
  const defaultBody: Region = { nodes: [] };

  throws(
    () => switchControl.create({
      selector,
      cases: [
        { matches: [1], body },
        { matches: [1], body }
      ],
      defaultBody
    }),
    /duplicate case match/
  );
  throws(
    () => switchControl.create({
      selector,
      cases: [{ matches: [256], body }],
      defaultBody
    }),
    /not an integer/
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
  const mapped = mapControlBodies(
    selection,
    (body) => body === selected ? replacement : body
  );

  notStrictEqual(mapped, selection);
  strictEqual(mapped.kind, "switch");
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

  strictEqual(controlCompletes(
    ifControl.create({
      condition: values.const(1),
      thenBody: completed,
      elseBody: completed
    }),
    completion
  ), true);
  strictEqual(controlCompletes(
    ifControl.create({
      condition: values.const(1),
      thenBody: completed,
      elseBody: incomplete
    }),
    completion
  ), false);
  strictEqual(controlCompletes(
    switchControl.create({
      selector: values.const(0),
      cases: [{ matches: [0], body: completed }],
      defaultBody: completed
    }),
    completion
  ), true);
});

test("return controls snapshot their result list", () => {
  const values = new ValueTable();
  const first = values.const(1);
  const results = [first];
  const control = returnControl.create({
    source: { kind: "values", values: results }
  });

  results.push(values.const(2));
  deepStrictEqual(control.source, {
    kind: "values",
    values: [first]
  });
});

test("invocation returns expose their argument and callee effects", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const variable = new VariableRef("i32");
  const target = new FunctionDefinition({
    ref: functionRef("test.controls.target"),
    type: functionType(["i32"], ["i32"]),
    effects: {
      reads: [{ space: "variable", variable }],
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
  const description = describeNode(returned);

  deepStrictEqual(invocationInputs(invocation), [{
    value: argument,
    type: "i32"
  }]);
  deepStrictEqual(description.operands, [argument]);
  deepStrictEqual(description.effects, target.effects);
  strictEqual(controlCompletes(
    returned,
    { regionCompletes: () => false }
  ), true);
});
