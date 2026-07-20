import {
  deepStrictEqual,
  notStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  IndirectCallTarget,
  Invocation
} from "#compiler/ir/invocation.js";
import {
  finishControl,
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl,
  type Control,
  type ControlEmitTarget
} from "#compiler/ir/controls/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { createModuleBindings } from "#compiler/program/bindings.js";
import { functionRef, tableRef } from "#compiler/program/refs.js";
import { CellRef } from "#compiler/refs/cell.js";
import type { Body } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";

function fixture() {
  const argument = valueId(1);
  const condition = valueId(3);
  const ifOutput = valueId(4);
  const selector = valueId(5);
  const switchOutput = valueId(6);
  const seed = valueId(7);
  const loopInput = valueId(8);
  const update = valueId(9);
  const result = valueId(10);
  const thenBody: Body = { nodes: [] };
  const elseBody: Body = { nodes: [] };
  const caseBody: Body = { nodes: [], result };
  const defaultBody: Body = { nodes: [], result };
  const loopBody: Body = { nodes: [] };
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
  const args = [{ value: argument, type: "i32" }] as const;
  const invocation = Invocation.create({
    target,
    arguments: args
  });
  const returnInvocation = returnControl.create({
    source: { kind: "invocation", invocation }
  });
  const branch = ifControl.create({
    condition,
    hint: "likely",
    output: ifOutput,
    thenBody,
    elseBody
  });
  const selection = switchControl.create({
    selector,
    output: switchOutput,
    cases: [{ matches: [2], body: caseBody }],
    defaultBody
  });
  const loop = loopControl.create({
    carried: [{ seed, loopInput }],
    body: loopBody
  });
  const loopContinue = loopContinueControl.create({ updates: [update] });
  const finish = finishControl.create({
    finish: { kind: "dispatch", targetEip: result }
  });
  const returnFromFunction = returnControl.create({
    source: { kind: "values", values: [result] }
  });

  return {
    values: {
      argument,
      condition,
      ifOutput,
      selector,
      switchOutput,
      seed,
      loopInput,
      update,
      result
    },
    bodies: { thenBody, elseBody, caseBody, defaultBody, loopBody },
    target,
    args,
    invocation,
    controls: {
      returnInvocation,
      branch,
      selection,
      loop,
      loopContinue,
      finish,
      returnFromFunction
    }
  };
}

test("control owners construct complete final nodes", () => {
  const { values, bodies, target, args, invocation, controls } = fixture();

  strictEqual(controls.returnInvocation.category, "control");
  strictEqual(controls.returnInvocation.kind, "return");
  deepStrictEqual(controls.returnInvocation.source, {
    kind: "invocation",
    invocation
  });
  strictEqual(invocation.target, target);
  deepStrictEqual(invocation.arguments, args);
  strictEqual("node" in controls.returnInvocation, false);

  strictEqual(controls.branch.category, "control");
  strictEqual(controls.branch.condition, values.condition);
  strictEqual(controls.branch.hint, "likely");
  strictEqual(controls.branch.output, values.ifOutput);
  strictEqual(controls.branch.thenBody, bodies.thenBody);
  strictEqual(controls.branch.elseBody, bodies.elseBody);

  strictEqual(controls.selection.selector, values.selector);
  strictEqual(controls.selection.output, values.switchOutput);
  deepStrictEqual(controls.selection.cases, [{ matches: [2], body: bodies.caseBody }]);
  strictEqual(controls.selection.defaultBody, bodies.defaultBody);

  deepStrictEqual(controls.loop.carried, [
    { seed: values.seed, loopInput: values.loopInput }
  ]);
  strictEqual(controls.loop.body, bodies.loopBody);
  deepStrictEqual(controls.loopContinue.updates, [values.update]);
  deepStrictEqual(controls.finish.finish, {
    kind: "dispatch",
    targetEip: values.result
  });
  deepStrictEqual(controls.returnFromFunction.source, {
    kind: "values",
    values: [values.result]
  });

  const metadataArgs = {
    condition: values.condition,
    thenBody: bodies.thenBody,
    callerMetadata: true
  };
  const withoutMetadata = ifControl.create(metadataArgs);

  strictEqual("callerMetadata" in withoutMetadata, false);
});

test("return controls snapshot their result list", () => {
  const results = [valueId(1)];
  const control = returnControl.create({
    source: { kind: "values", values: results }
  });

  results.push(valueId(2));
  deepStrictEqual(control.source, {
    kind: "values",
    values: [valueId(1)]
  });
});

test("direct control facts describe operands, bodies, outputs, and effects", () => {
  const { values, bodies, target, controls } = fixture();
  const ordered: readonly Control[] = [
    controls.returnInvocation,
    controls.branch,
    controls.selection,
    controls.loop,
    controls.loopContinue,
    controls.finish,
    controls.returnFromFunction
  ];

  deepStrictEqual(ordered.map((control) => control.operands), [
    [values.argument],
    [values.condition],
    [values.selector],
    [values.seed],
    [values.update],
    [values.result],
    [values.result]
  ]);
  deepStrictEqual(controls.branch.nestedBodies, [
    {
      body: bodies.thenBody,
      role: "thenBody",
      scope: { kind: "ordinary" }
    },
    {
      body: bodies.elseBody,
      role: "elseBody",
      scope: { kind: "ordinary" }
    }
  ]);
  deepStrictEqual(controls.selection.nestedBodies, [
    {
      body: bodies.caseBody,
      role: "case[0]",
      scope: { kind: "ordinary" }
    },
    {
      body: bodies.defaultBody,
      role: "default",
      scope: { kind: "ordinary" }
    }
  ]);
  deepStrictEqual(controls.loop.nestedBodies, [{
    body: bodies.loopBody,
    role: "body",
    scope: { kind: "loop", inputs: [values.loopInput] }
  }]);
  deepStrictEqual(
    [
      controls.returnInvocation,
      controls.loopContinue,
      controls.finish,
      controls.returnFromFunction
    ].flatMap((control) => control.nestedBodies),
    []
  );
  deepStrictEqual(ordered.map((control) => control.outputs), [
    [],
    [values.ifOutput],
    [values.switchOutput],
    [],
    [],
    [],
    []
  ]);
  deepStrictEqual(
    ordered.map((control) => control.nestedBodies.length !== 0),
    [false, true, true, true, false, false, false]
  );
  deepStrictEqual(ordered.map((control) => control.directEffects), [
    target.effects,
    { reads: [], writes: [] },
    { reads: [], writes: [] },
    { reads: [], writes: [] },
    { reads: [], writes: [] },
    { reads: [], writes: [] },
    { reads: [], writes: [] }
  ]);
});

test("direct completion methods use nested body completion", () => {
  const { values, bodies, controls } = fixture();
  const completingBodies = new Set<Body>([
    bodies.thenBody,
    bodies.elseBody,
    bodies.caseBody,
    bodies.defaultBody
  ]);
  const completion = {
    bodyCompletes: (body: Body) => completingBodies.has(body)
  };
  const ordered: readonly Control[] = [
    controls.returnInvocation,
    controls.branch,
    controls.selection,
    controls.loop,
    controls.loopContinue,
    controls.finish,
    controls.returnFromFunction
  ];

  deepStrictEqual(ordered.map((control) => control.completes(completion)), [
    true,
    true,
    true,
    false,
    true,
    true,
    true
  ]);
  strictEqual(
    ifControl.create({
      condition: values.condition,
      thenBody: bodies.thenBody
    }).completes(completion),
    false
  );
  strictEqual(
    switchControl.create({
      selector: values.selector,
      output: values.switchOutput,
      cases: [{ matches: [0], body: bodies.caseBody }],
      defaultBody: { nodes: [] }
    }).completes(completion),
    false
  );
});

test("a control-only switch owns no output and shares a body across matches", () => {
  const selector = valueId(30);
  const selected: Body = { nodes: [] };
  const fallback: Body = { nodes: [] };
  const selection = switchControl.create({
    selector,
    cases: [{
      matches: [1, 3, 5],
      body: selected
    }],
    defaultBody: fallback
  });

  strictEqual(selection.output, undefined);
  deepStrictEqual(selection.outputs, []);
  deepStrictEqual(selection.operands, [selector]);
  deepStrictEqual(selection.cases, [{
    matches: [1, 3, 5],
    body: selected
  }]);
  deepStrictEqual(
    selection.nestedBodies.map((entry) => entry.body),
    [selected, fallback]
  );
  strictEqual(
    selection.completes({ bodyCompletes: (body) => body === selected || body === fallback }),
    true
  );

  const replacement: Body = { nodes: [] };
  const mapped = selection.mapBodies((body) => body === selected ? replacement : body);

  strictEqual(mapped.output, undefined);
  deepStrictEqual(mapped.outputs, []);
  strictEqual(mapped.cases[0]?.body, replacement);
  deepStrictEqual(mapped.cases[0]?.matches, [1, 3, 5]);
});

test("a completing control-only switch seals its enclosing emission path", () => {
  const selector = valueId(30);
  const selected: Body = { nodes: [] };
  const fallback: Body = { nodes: [] };
  const selection = switchControl.create({
    selector,
    cases: [{ matches: [1, 3], body: selected }],
    defaultBody: fallback
  });
  const body = new WasmFunctionBodyEncoder();
  const emittedBodies: Body[] = [];
  let sealed = 0;

  selection.emit({
    ...rawControlTarget(body),
    bodyCompletes: () => true,
    emitCaptures: () => {},
    emitBody: (nested, outputLocal) => {
      strictEqual(outputLocal, undefined);
      emittedBodies.push(nested);
    },
    withNestedControl: (emit) => emit(),
    sealCompletedStructuredControl: () => { sealed += 1; }
  }, {
    emitUse(value) {
      strictEqual(value, selector);
      body.i32Const(0);
    }
  });
  const encoded = body.finish();

  deepStrictEqual(emittedBodies, [selected, fallback]);
  strictEqual(sealed, 1);
  strictEqual(wasmBodyOpcodes(encoded.bytes).includes(wasmOpcode.brTable), true);
});

test("direct body mapping follows each control's owned structure", () => {
  const { values, bodies, controls } = fixture();
  const replacements = new Map<Body, Body>([
    [bodies.thenBody, { nodes: [], result: valueId(21) }],
    [bodies.elseBody, { nodes: [], result: valueId(22) }],
    [bodies.caseBody, { nodes: [], result: valueId(23) }],
    [bodies.defaultBody, { nodes: [], result: valueId(24) }],
    [bodies.loopBody, { nodes: [] }]
  ]);
  const replace = (body: Body): Body => replacements.get(body) ?? body;
  const mappedBranch = controls.branch.mapBodies(replace);
  const mappedSelection = controls.selection.mapBodies(replace);
  const mappedLoop = controls.loop.mapBodies(replace);

  notStrictEqual(mappedBranch, controls.branch);
  notStrictEqual(mappedSelection, controls.selection);
  notStrictEqual(mappedLoop, controls.loop);
  deepStrictEqual(
    mappedBranch.nestedBodies.map((entry) => entry.body),
    [replacements.get(bodies.thenBody), replacements.get(bodies.elseBody)]
  );
  deepStrictEqual(
    mappedSelection.nestedBodies.map((entry) => entry.body),
    [replacements.get(bodies.caseBody), replacements.get(bodies.defaultBody)]
  );
  deepStrictEqual(
    mappedLoop.nestedBodies.map((entry) => entry.body),
    [replacements.get(bodies.loopBody)]
  );
  deepStrictEqual(mappedBranch.outputs, [values.ifOutput]);
  deepStrictEqual(mappedSelection.outputs, [values.switchOutput]);
  for (const leaf of [
    controls.returnInvocation,
    controls.loopContinue,
    controls.finish,
    controls.returnFromFunction
  ]) {
    deepStrictEqual(leaf.mapBodies(replace).operands, leaf.operands);
  }
});

test("a return sourced by an invocation directly emits Wasm return_call", () => {
  const { values, target, controls } = fixture();
  const emitted = emitRawControl(controls.returnInvocation, target);

  deepStrictEqual(emitted.uses, [values.argument]);
  deepStrictEqual(emitted.functionIndices, [7]);
  deepStrictEqual(emitted.opcodes, [
    wasmOpcode.i32Const,
    wasmOpcode.returnCall,
    wasmOpcode.end
  ]);
  strictEqual(
    controls.returnInvocation.completes({ bodyCompletes: () => false }),
    true
  );
  deepStrictEqual(controls.returnInvocation.outputs, []);
  throws(
    () => Invocation.create({
      target,
      arguments: []
    }),
    /expects 1 arguments, got 0/
  );
});

test("an indirect invocation return emits arguments, selector, and return_call_indirect", () => {
  const argument = valueId(30);
  const elementIndex = valueId(31);
  const table = tableRef("test.controls.table");
  const type = functionType(["i32"], ["i32"]);
  const invocation = Invocation.create({
    target: IndirectCallTarget.create({
      table,
      type,
      effects: { reads: [], writes: [] },
      elementIndex: { value: elementIndex, type: "i32" }
    }),
    arguments: [{ value: argument, type: "i32" }]
  });
  const control = returnControl.create({
    source: { kind: "invocation", invocation }
  });
  const body = new WasmFunctionBodyEncoder();
  const uses: ValueId[] = [];

  control.emit({
    ...rawControlTarget(body),
    bindings: createModuleBindings({
      functionDefinitions: new Map(),
      types: new Map([[type, 5]]),
      tables: new Map([[table, 6]]),
      resources: new Map()
    })
  }, {
    emitUse(value) {
      uses.push(value);
      body.i32Const(value);
    }
  });
  const encoded = body.finish();

  deepStrictEqual(uses, [argument, elementIndex]);
  deepStrictEqual(encoded.references.typeIndices, [5]);
  deepStrictEqual(encoded.references.tableIndices, [6]);
  strictEqual(encoded.bytes.includes(wasmOpcode.returnCallIndirect), true);
});

test("return and finish controls directly emit their terminal behavior", () => {
  const { values, target, controls } = fixture();
  const returned = emitRawControl(controls.returnFromFunction, target);

  deepStrictEqual(returned.uses, [values.result]);
  deepStrictEqual(returned.functionIndices, []);
  deepStrictEqual(returned.opcodes, [
    wasmOpcode.i32Const,
    wasmOpcode.return,
    wasmOpcode.end
  ]);

  const finished = emitRawControl(controls.finish, target);

  deepStrictEqual(finished.uses, []);
  strictEqual(finished.dispatched, values.result);
  deepStrictEqual(finished.opcodes, [wasmOpcode.end]);
});

test("RegionBuilder emits an ordinary CallOperation and owner-defined controls", () => {
  const values = new ValueTable();
  const target = fixture().target;
  const argument = values.const(1);
  const condition = values.external(0);
  const builder = new RegionBuilder(values, undefined, ["i32"]);
  const [callOutput] = builder.call(target, [argument]);

  ok(callOutput !== undefined);
  builder.returnCall(target, [argument]);
  builder.if(condition, () => {}, {
    hint: "unlikely",
    elseBuild: () => {}
  });
  const selectionOutput = builder.switch(
    condition,
    [{ match: 3, build: (arm) => arm.values.const(2) }],
    (fallback) => fallback.values.const(4)
  );
  builder.loop([], () => {});
  builder.loopContinue([]);
  const finish = { kind: "dispatch", targetEip: argument } as const;

  builder.finish(finish);
  builder.return([argument]);

  const nodes = builder.build().nodes;

  deepStrictEqual(nodes.map((node) => node.kind), [
    "call",
    "return",
    "if",
    "switch",
    "loop",
    "loopContinue",
    "finish",
    "return"
  ]);
  deepStrictEqual(nodes.map((node) => node.category), [
    "operation",
    "control",
    "control",
    "control",
    "control",
    "control",
    "control",
    "control"
  ]);
  deepStrictEqual(nodes[0]!.outputs, [callOutput]);
  deepStrictEqual(nodes[1]!.operands, [argument]);
  deepStrictEqual(nodes[2]!.nestedBodies, [
    { body: { nodes: [] }, role: "thenBody", scope: { kind: "ordinary" } },
    { body: { nodes: [] }, role: "elseBody", scope: { kind: "ordinary" } }
  ]);
  deepStrictEqual(nodes[3]!.outputs, [selectionOutput]);
});

function emitRawControl(
  control: Control,
  expectedTarget: FunctionDefinition
): Readonly<{
  uses: readonly ValueId[];
  functionIndices: readonly number[];
  typeIndices: readonly number[];
  tableIndices: readonly number[];
  opcodes: readonly number[];
  dispatched: ValueId | undefined;
}> {
  const body = new WasmFunctionBodyEncoder();
  const uses: ValueId[] = [];
  let dispatched: ValueId | undefined;
  const target = rawControlTarget(body, expectedTarget, (value) => {
    dispatched = value;
  });

  control.emit(target, {
    emitUse(value) {
      uses.push(value);
      body.i32Const(value);
    }
  });
  const encoded = body.finish();

  return {
    uses,
    functionIndices: encoded.references.functionIndices,
    typeIndices: encoded.references.typeIndices,
    tableIndices: encoded.references.tableIndices,
    opcodes: wasmBodyOpcodes(encoded.bytes),
    dispatched
  };
}

function rawControlTarget(
  body: WasmFunctionBodyEncoder,
  expectedFunction?: FunctionDefinition,
  dispatch: (value: ValueId) => void = unsupported
): ControlEmitTarget {
  return {
    body,
    bindings: createModuleBindings({
      functionDefinitions: expectedFunction === undefined
        ? new Map()
        : new Map([[expectedFunction, 7]]),
      types: new Map(),
      tables: new Map(),
      resources: new Map()
    }),
    bodyCompletes: () => false,
    emitCaptures: unsupported,
    emitBody: unsupported,
    controlOutputLocal: unsupported,
    markControlOutput: unsupported,
    valueLocal: unsupported,
    withNestedControl: unsupported,
    withLoopBody: unsupported,
    currentLoopLocals: unsupported,
    emitLoopBranch: unsupported,
    emitExit: unsupported,
    emitDispatch: dispatch,
    sealCompletedStructuredControl: unsupported
  };
}

function unsupported(): never {
  throw new Error("raw control requested structured emission services");
}
