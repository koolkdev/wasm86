import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  IndirectCallTarget,
  Invocation
} from "#compiler/ir/invocation.js";
import { callOperation } from "#compiler/ir/operations/call.js";
import { variableRead, variableWrite } from "#compiler/ir/operations/variables.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { VariableRef } from "#compiler/ir/variable.js";
import { functionType } from "#compiler/ir/function.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { describeNode } from "#compiler/ir/node.js";

test("resource definitions describe their graph and resource interface", () => {
  const values = new ValueTable();
  const resource = resourceRef("test.resource");
  const origin = new DynamicByteOriginRef();
  const range: ByteRange = {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset: 6, byteLength: 2 }
  };
  const address = values.parameter(0, "i32");
  const stored = values.parameter(1, "i32");
  const source = byteOperand(resource, range, address, 6, 16);
  const read = resourceRead.create(
    { source, mode: { kind: "signed" } },
    (result) => {
      deepStrictEqual(result, {
        type: "i32",
        bounds: { unsignedBits: 32, signedBits: 16 }
      });
      return values.addNodeOutput(result.bounds);
    }
  );
  const write = resourceWrite.create({
    destination: source,
    value: stored
  });

  strictEqual(read.source, source);
  deepStrictEqual(read.mode, { kind: "signed" });
  strictEqual(write.destination, source);
  strictEqual(write.value, stored);
  deepStrictEqual(describeNode(read), {
    inputs: [{ value: address, type: "i32" }],
    operands: [address],
    results: [{
      type: "i32",
      bounds: { unsignedBits: 32, signedBits: 16 }
    }],
    outputs: [read.output],
    nestedBodies: [],
    effects: {
      reads: [source.effect],
      writes: []
    },
    referencedResources: [resource]
  });
  deepStrictEqual(describeNode(write), {
    inputs: [
      { value: address, type: "i32" },
      { value: stored, type: "i32" }
    ],
    operands: [address, stored],
    results: [],
    outputs: [],
    nestedBodies: [],
    effects: {
      reads: [],
      writes: [source.effect]
    },
    referencedResources: [resource]
  });
});

test("resource read modes define their result bounds", () => {
  const values = new ValueTable();
  const resource = resourceRef("test.read-bounds");
  const source = byteOperand(
    resource,
    { basis: { kind: "resource" } },
    values.const(0),
    0,
    8
  );
  const resultOf = (
    mode?: { readonly kind: "signed" } |
      { readonly kind: "unsigned"; readonly bounds: { unsignedBits: number; signedBits: number } }
  ) => {
    let result: unknown;

    resourceRead.create({ source, ...(mode === undefined ? {} : { mode }) }, (declared) => {
      result = declared;
      if (declared.type !== "i32") {
        throw new Error("resource read declared a non-i32 result");
      }
      return values.addNodeOutput(declared.bounds);
    });
    return result;
  };

  deepStrictEqual(resultOf(), {
    type: "i32",
    bounds: { unsignedBits: 8, signedBits: 9 }
  });
  deepStrictEqual(resultOf({ kind: "signed" }), {
    type: "i32",
    bounds: { unsignedBits: 32, signedBits: 8 }
  });
  deepStrictEqual(
    resultOf({ kind: "unsigned", bounds: { unsignedBits: 1, signedBits: 2 } }),
    {
      type: "i32",
      bounds: { unsignedBits: 1, signedBits: 2 }
    }
  );
  throws(
    () => resourceRead.create(
      { source: { ...source, width: 32 }, mode: { kind: "signed" } },
      () => values.addNodeOutput()
    ),
    /32-bit resource read has no signed extension/
  );
});

test("variable definitions describe typed accesses", () => {
  const values = new ValueTable();
  const variable = new VariableRef("i32");
  const wide = new VariableRef("i64");
  const stored = values.parameter(0, "i32");
  const wideStored = values.parameter(1, "i64");
  const read = variableRead.create({ variable }, () => values.addNodeOutput());
  const wideRead = variableRead.create({ variable: wide }, () => values.addNodeOutput64());
  const write = variableWrite.create({
    variable,
    value: stored,
    initialization: "seed"
  });
  const wideWrite = variableWrite.create({
    variable: wide,
    value: wideStored,
    initialization: "update"
  });

  deepStrictEqual(describeNode(read).results, [{ type: "i32" }]);
  deepStrictEqual(describeNode(wideRead).results, [{ type: "i64" }]);
  deepStrictEqual(describeNode(read).effects, {
    reads: [{ space: "variable", variable }],
    writes: []
  });
  deepStrictEqual(describeNode(write).effects, {
    reads: [],
    writes: [{ space: "variable", variable }]
  });
  strictEqual(write.initialization, "seed");
  deepStrictEqual(describeNode(wideWrite).inputs, [{
    value: wideStored,
    type: "i64"
  }]);
});

test("ordinary calls validate arguments and carry target effects", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const target = functionDefinition("test.call", ["i32"], ["i32"]);
  const invocation = Invocation.create({
    target,
    arguments: [{ value: argument, type: "i32" }]
  });
  const operation = callOperation.create(
    { invocation },
    () => values.addNodeOutput()
  );

  strictEqual(operation.invocation, invocation);
  deepStrictEqual(describeNode(operation).operands, [argument]);
  strictEqual(describeNode(operation).effects, target.effects);
  strictEqual(operation.output, describeNode(operation).outputs[0]);
  throws(
    () => Invocation.create({ target, arguments: [] }),
    /expects 1 arguments, got 0/
  );

  const multiResult = functionDefinition(
    "test.call-multi-result",
    [],
    ["i32", "i64"]
  );

  throws(
    () => callOperation.create({
      invocation: Invocation.create({
        target: multiResult,
        arguments: []
      })
    }, () => values.addNodeOutput()),
    /multiple call results are not supported/
  );
});

test("indirect invocations include the table selector in their inputs", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i64");
  const elementIndex = values.parameter(1, "i32");
  const table = tableRef("test.call-table");
  const type = functionType(["i64"], ["i32"]);
  const effects = { reads: [], writes: [] } as const;
  const target = IndirectCallTarget.create({
    table,
    type,
    effects,
    elementIndex: { value: elementIndex, type: "i32" }
  });
  const invocation = Invocation.create({
    target,
    arguments: [{ value: argument, type: "i64" }]
  });
  const operation = callOperation.create(
    { invocation },
    () => values.addNodeOutput()
  );

  deepStrictEqual(invocation.inputs, [
    { value: argument, type: "i64" },
    { value: elementIndex, type: "i32" }
  ]);
  deepStrictEqual(describeNode(operation).operands, [argument, elementIndex]);
  strictEqual(target.table, table);
  strictEqual(target.effects, effects);
  throws(
    () => IndirectCallTarget.create({
      table,
      type,
      effects,
      elementIndex: { value: elementIndex, type: "i64" }
    }),
    /table element index must be i32, got i64/
  );
});

function functionDefinition(
  id: string,
  parameters: readonly ("i32" | "i64")[],
  results: readonly ("i32" | "i64")[]
): FunctionDefinition {
  return new FunctionDefinition({
    ref: functionRef(id),
    type: functionType(parameters, results),
    effects: { reads: [], writes: [] },
    owner: undefined,
    build: () => {}
  });
}

function byteOperand(
  resource: ResourceRef,
  range: ByteRange,
  base: ValueId,
  displacement: number,
  width: IntegerWidth
): ResourceByteOperand {
  return {
    effect: { space: "resource", resource, range },
    address: { base, displacement },
    width
  };
}
