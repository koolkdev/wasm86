import {
  deepStrictEqual,
  doesNotThrow,
  notStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { RegionNode } from "#compiler/ir/region.js";
import {
  buildFunction,
  FunctionBuilder
} from "#compiler/ir/builder/function.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceByteOperand
} from "#compiler/ir/resource.js";
import { RegionBuilder, type RegionNodeSink } from "#compiler/ir/builder/region.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { valueId } from "#compiler/ir/values/id.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import {
  compilerTestResourceEffect,
  resourceWriteNode
} from "#test/support/storage-operations.js";

function readArgs(values: ValueTable, region = 0) {
  return {
    source: {
      effect: compilerTestResourceEffect(region),
      address: { base: values.const(0), displacement: region * 4 },
      width: 32
    }
  } as const;
}

function writeArgs(values: ValueTable, value: ValueId, region = 0) {
  return {
    destination: {
      effect: compilerTestResourceEffect(region),
      address: { base: values.const(0), displacement: region * 4 },
      width: 32
    },
    value
  } as const;
}

function testCallTarget(id: string): FunctionDefinition {
  return new FunctionDefinition({
    ref: functionRef(id),
    type: functionType(["i32", "i32", "i32", "i32"], ["i32"]),
    effects: { reads: [], writes: [] },
    owner: undefined,
    build: () => {}
  });
}

function voidFunction(values: ValueTable, builder: RegionBuilder) {
  builder.return([]);
  const parameters = Array.from(
    { length: values.size() },
    (_, raw) => valueId(raw)
  ).filter((value) => values.node(value).kind === "parameter")
    .sort((a, b) => {
      const first = values.node(a);
      const second = values.node(b);

      return first.kind === "parameter" && second.kind === "parameter"
        ? first.index - second.index
        : 0;
    });

  return {
    type: functionType(
      parameters.map((parameter) => values.valueType(parameter)),
      []
    ),
    parameters,
    values,
    body: builder.build()
  };
}

test("operation derives the output and its bounds from the definition", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const resource = resourceRef("test.region-builder-resource");
  const address = values.const(0);
  const source: ResourceByteOperand = {
    effect: {
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 1 }
      }
    },
    address: { base: address, displacement: 0 },
    width: 8
  };
  const read = builder.operation(resourceRead, { source });
  const [operation] = builder.build().nodes;

  ok(operation?.kind === "resource.read");
  strictEqual(operation.effect, source.effect);
  deepStrictEqual(operation.outputs, [read]);
  deepStrictEqual(values.widthBounds(read), fitsUnsigned(8));
});

test("resource read modes reach operation construction", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const resource = resourceRef("test.region-builder-refined-resource");
  const source: ResourceByteOperand = {
    effect: {
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 1 }
      }
    },
    address: { base: values.const(0), displacement: 0 },
    width: 8
  };

  const signed = builder.operation(resourceRead, {
    source,
    mode: { kind: "signed" }
  });
  const bounded = builder.operation(resourceRead, {
    source,
    mode: {
      kind: "unsigned",
      bounds: fitsUnsigned(1)
    }
  });

  const [signedOperation, boundedOperation] = builder.build().nodes;

  ok(signedOperation?.kind === "resource.read");
  ok(boundedOperation?.kind === "resource.read");
  strictEqual(signedOperation.signed, true);
  strictEqual(boundedOperation.signed, undefined);
  deepStrictEqual(values.widthBounds(signed), signExtended(8));
  deepStrictEqual(values.widthBounds(bounded), fitsUnsigned(1));
});

test("one operation API handles value and effect definitions", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const value = values.const(0);

  strictEqual(builder.operation(resourceWrite, writeArgs(values, value)), undefined);
  strictEqual(builder.operation(resourceRead, readArgs(values)), value + 1);
});

test("call validates typed arguments and allocates its declared result", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const target = testCallTarget("test.region-builder.call-target");
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  const [output] = builder.call(target, args);

  ok(output !== undefined, "expected status-flag call result");
  const [call] = builder.build().nodes;

  ok(call?.kind === "call");
  strictEqual(call.invocation.target, target);
  deepStrictEqual(call.inputs, args.map((value) => ({ value, type: "i32" as const })));
  deepStrictEqual(call.outputs, [output]);
  deepStrictEqual(values.node(output), { kind: "nodeOutput", type: "i32" });
  throws(() => builder.call(target, args.slice(1)), /expects 4 arguments, got 3/);
  throws(
    () => builder.call(target, [args[0]!, args[1]!, args[2]!, values.const64(3n)]),
    /argument 3 must be i32, got i64/
  );
});

test("call and returnCall share indirect target normalization", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values, undefined, ["i32"]);
  const argument = values.const64(4n);
  const elementIndex = values.const(2);
  const table = tableRef("test.region-builder.call-table");
  const type = functionType(["i64"], ["i32"]);
  const effects = { reads: [], writes: [] } as const;
  const target = builder.indirectTarget({
    table,
    type,
    effects,
    elementIndex
  });
  const [output] = builder.call(target, [argument]);

  builder.returnCall(target, [argument]);
  const [call, returned] = builder.build().nodes;

  ok(output !== undefined);
  ok(call?.kind === "call");
  ok(returned?.kind === "return");
  strictEqual(returned.source.kind, "invocation");
  if (returned.source.kind !== "invocation") {
    throw new Error("expected invocation return source");
  }
  const callInvocation = call.invocation;
  const returnInvocation = returned.source.invocation;

  deepStrictEqual(callInvocation.arguments, [{ value: argument, type: "i64" }]);
  deepStrictEqual(callInvocation.inputs, [
    { value: argument, type: "i64" },
    { value: elementIndex, type: "i32" }
  ]);
  strictEqual(callInvocation.target, target);
  strictEqual(returnInvocation.target, target);
  deepStrictEqual(target.elementIndex, { value: elementIndex, type: "i32" });
  deepStrictEqual(call.operands, [argument, elementIndex]);
  deepStrictEqual(returnInvocation.inputs, callInvocation.inputs);
  deepStrictEqual(returned.operands, [argument, elementIndex]);
  deepStrictEqual(call.outputs, [output]);
  throws(
    () => builder.indirectTarget({
      table,
      type,
      effects,
      elementIndex: values.const64(1n)
    }),
    /table element index must be i32, got i64/
  );
});

test("cell APIs seed typed cells and preserve lexical access in child bodies", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const seed = values.const64(7n);
  const cell = builder.cell(seed);
  let read!: ValueId;

  builder.if(values.parameter(0, "i32"), (child) => {
    child.write(cell, child.values.const64(8n));
    read = child.read(cell);
  });

  const block = voidFunction(values, builder);
  const seedOperation = block.body.nodes[0];
  const branch = block.body.nodes[1];

  strictEqual(cell.type, "i64");
  strictEqual(values.valueType(read), "i64");
  ok(seedOperation?.kind === "cell.write");
  strictEqual(seedOperation.initialization, "seed");
  ok(branch?.kind === "if");
  strictEqual(branch.thenBody.nodes[0]?.kind, "cell.write");
  strictEqual(branch.thenBody.nodes[1]?.kind, "cell.read");
  doesNotThrow(() => validateIrFunction(block));
});

test("validation rejects writes whose value type differs from the cell", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const cell = builder.cell(values.const(1));

  builder.write(cell, values.const64(2n));

  throws(
    () => validateIrFunction(voidFunction(values, builder)),
    /operand .* must be i32, got i64/
  );
});

test("validation rejects a cell access transplanted away from its seed", () => {
  const values = new ValueTable();
  const source = new RegionBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const sourceNodes = source.build().nodes;
  const target = new RegionBuilder(values);

  // Moving only the read leaves its declaring seed behind in another tree.
  target.push(sourceNodes[1]!);

  throws(
    () => validateIrFunction(voidFunction(values, target)),
    /uses a cell with no seed in this root/
  );
});

test("a transplanted seed carries its cell's scope with it", () => {
  // Scope is where the seed is: relocating the whole seed+use sequence into
  // another root is structurally sound, with no stale metadata to desync.
  const values = new ValueTable();
  const source = new RegionBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const target = new RegionBuilder(values);

  target.extend(source.build().nodes);

  doesNotThrow(() => validateIrFunction(voidFunction(values, target)));
});

test("effect, push, and extend append nodes without outputs", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const prebuilt = resourceWriteNode(values, 0, values.const(4));
  const other = resourceWriteNode(values, 0, values.const(8));

  const built = builder.operation(resourceWrite, writeArgs(values, values.const(0)));

  strictEqual(built, undefined);
  builder.push(prebuilt);
  builder.extend([other]);
  const [first, second, third] = builder.build().nodes;

  ok(first?.kind === "resource.write");
  strictEqual(second, prebuilt);
  strictEqual(third, other);
});

test("custom node sinks can divert emitted top-level nodes", () => {
  const values = new ValueTable();
  const sink = new class implements RegionNodeSink {
    readonly bodyNodes: RegionNode[] = [];
    readonly diverted: RegionNode[] = [];

    push(node: RegionNode): void {
      if (node.kind === "resource.read") {
        this.diverted.push(node);
        return;
      }

      this.bodyNodes.push(node);
    }

    nodes(): readonly RegionNode[] {
      return this.bodyNodes;
    }
  }();
  const builder = new RegionBuilder(values, sink);
  const read = builder.operation(resourceRead, readArgs(values));

  builder.operation(resourceWrite, writeArgs(values, values.const(4)));

  deepStrictEqual(sink.diverted[0]?.outputs, [read]);
  strictEqual(builder.build().nodes[0]?.kind, "resource.write");
});

test("if builds hinted then and else bodies against child builders", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values, undefined, ["i64"]);
  const condition = values.parameter(0, "i32");
  const exitResult = values.const64(0n);

  builder.if(
    condition,
    (then) => then.operation(
      resourceWrite,
      writeArgs(then.values, then.values.const(4))
    ),
    {
      hint: "unlikely",
      elseBuild: (other) => other.return([exitResult])
    }
  );
  const [control] = builder.build().nodes;

  ok(control?.kind === "if");
  strictEqual(control.condition, condition);
  strictEqual(control.hint, "unlikely");
  strictEqual(control.thenBody.nodes[0]?.kind, "resource.write");
  const [returned] = control.elseBody?.nodes ?? [];

  ok(returned?.kind === "return");
  deepStrictEqual(returned.source, {
    kind: "values",
    values: [exitResult]
  });
});

test("control bodies isolate siblings while retaining ancestor recipes", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const input = values.addNodeOutput();
  const operand = values.parameter(0, "i32");
  let thenValue!: ValueId;
  let nestedValue!: ValueId;
  let elseValue!: ValueId;

  builder.if(
    values.parameter(1, "i32"),
    (then) => {
      thenValue = then.values.binary("add", input, operand);
      strictEqual(then.values.binary("add", input, operand), thenValue);
      then.if(values.parameter(2, "i32"), (nested) => {
        nestedValue = nested.values.binary("add", input, operand);
      });
    },
    {
      elseBuild: (other) => {
        elseValue = other.values.binary("add", input, operand);
      }
    }
  );

  const rootValue = values.binary("add", input, operand);

  notStrictEqual(thenValue, rootValue);
  notStrictEqual(elseValue, rootValue);
  notStrictEqual(thenValue, elseValue);
  strictEqual(nestedValue, thenValue);
  deepStrictEqual(values.node(thenValue), {
    kind: "binary",
    type: "i32",
    operator: "add",
    a: input,
    b: operand
  });
  deepStrictEqual(values.node(nestedValue), values.node(thenValue));
});

test("function snapshots retain values created in control children", () => {
  const fn = new FunctionBuilder(functionType(["i32", "i32"], ["i32"]));
  const [condition, input] = fn.parameters;

  ok(condition !== undefined && input !== undefined);
  let childValue!: ValueId;

  const result = fn.region.ifValue(
    condition,
    (child) => {
      childValue = child.values.binary("add", input, child.values.const(1));
      return childValue;
    },
    () => input
  );

  fn.return([result]);

  const built = fn.finish();

  doesNotThrow(() => validateIrFunction(built));
  deepStrictEqual(built.values.node(childValue), {
    kind: "binary",
    type: "i32",
    operator: "add",
    a: input,
    b: built.values.const(1)
  });
  strictEqual(built.values.valueType(childValue), "i32");
  deepStrictEqual(built.values.widthBounds(childValue), fitsUnsigned(32));
  strictEqual(built.values.mayTrap(childValue), false);
});

test("switch builds every arm before allocating the shared output", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const selector = values.parameter(0, "i32");
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  const target = testCallTarget("test.region-builder.switch-call-target");
  let armResult!: ValueId;
  let defaultResult!: ValueId;
  const output = builder.switch(
    selector,
    [{
      match: 3,
      build: (arm) => {
        const [result] = arm.call(target, args);

        ok(result !== undefined, "expected call result");
        return (armResult = result);
      }
    }],
    (arm) => (defaultResult = arm.values.const(1))
  );

  ok(armResult < output);
  ok(defaultResult < output);
  deepStrictEqual(values.widthBounds(output), { unsignedBits: 32, signedBits: 32 });
  const [control] = builder.build().nodes;

  ok(control?.kind === "switch");
  strictEqual(control.selector, selector);
  deepStrictEqual(control.outputs, [output]);
  deepStrictEqual(control.cases[0]?.matches, [3]);
  strictEqual(control.cases[0]?.body.result, armResult);
  const [call] = control.cases[0]?.body.nodes ?? [];

  ok(call?.kind === "call");
  strictEqual(call.invocation.target, target);
  deepStrictEqual(call.outputs, [armResult]);
  deepStrictEqual(control.defaultBody, { nodes: [], result: defaultResult });
});

test("switch derives its output bounds from reachable arms", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const output = builder.switch(
    values.parameter(0, "i32"),
    [{ match: 0, build: (arm) => arm.values.unreachable() }],
    (arm) => arm.values.const(0)
  );

  deepStrictEqual(values.widthBounds(output), { unsignedBits: 1, signedBits: 1 });
});

test("control-only switch shares one body across all matches in an arm", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const selector = values.parameter(0, "i32");
  let armBuilds = 0;

  builder.switchControl(
    selector,
    [{
      matches: [1, 3, 5],
      build: (arm) => {
        armBuilds += 1;
        arm.operation(resourceWrite, writeArgs(arm.values, arm.values.const(7)));
      }
    }],
    (fallback) => fallback.operation(
      resourceWrite,
      writeArgs(fallback.values, fallback.values.const(9))
    )
  );

  strictEqual(armBuilds, 1);
  const [control] = builder.build().nodes;

  ok(control?.kind === "switch");
  strictEqual(control.output, undefined);
  deepStrictEqual(control.outputs, []);
  deepStrictEqual(control.cases[0]?.matches, [1, 3, 5]);
  strictEqual(control.cases[0]?.body.nodes.length, 1);
  strictEqual(control.cases[0]?.body.result, undefined);
  strictEqual(control.defaultBody.result, undefined);
  strictEqual(control.cases[0]?.body.nodes[0]?.kind, "resource.write");
  strictEqual(control.defaultBody.nodes[0]?.kind, "resource.write");
});

test("control-only switch rejects an arm without matches before building bodies", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  let built = false;

  throws(
    () => builder.switchControl(
      values.const(0),
      [{ matches: [], build: () => { built = true; } }],
      () => { built = true; }
    ),
    /control-only switch arm 0 has no matches/
  );
  strictEqual(built, false);
  deepStrictEqual(builder.build().nodes, []);
});

test("loop bodies take the back edge through loopContinue and validate", () => {
  const fn = buildFunction(functionType([], ["i64"]), (fn) => {
    const input = fn.values.addLoopInput();

    fn.region.loop([{ seed: fn.values.const(3), loopInput: input }], (body) => {
      const next = body.values.binary("sub", input, body.values.const(1));

      body.if(body.values.compare(32, "ne", next, body.values.const(0)), (taken) => taken.loopContinue([next]));
    });
    fn.return([fn.values.const64(0n)]);
  });

  doesNotThrow(() => validateIrFunction(fn));
});

test("buildFunction returns a callback-produced value", () => {
  let eip!: ValueId;
  const fn = buildFunction(functionType([], ["i32"]), (fn) => {
    eip = fn.region.operation(resourceRead, readArgs(fn.values));
    fn.return([eip]);
  });
  const returned = fn.body.nodes.at(-1);

  ok(returned?.kind === "return");
  deepStrictEqual(returned.source, { kind: "values", values: [eip] });
  strictEqual(fn.body.result, undefined);
  doesNotThrow(() => validateIrFunction(fn));
});

test("buildFunction supports a void callback", () => {
  const fn = buildFunction(functionType([], []), (fn) => {
    fn.region.operation(
      resourceWrite,
      writeArgs(fn.values, fn.values.const(0))
    );
    fn.return([]);
  });

  strictEqual(fn.body.result, undefined);
  strictEqual(fn.body.nodes.at(-1)?.kind, "return");
  doesNotThrow(() => validateIrFunction(fn));
});
