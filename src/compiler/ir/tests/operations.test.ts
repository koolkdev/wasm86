import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  IndirectCallTarget,
  Invocation
} from "#compiler/ir/invocation.js";
import { callOperation } from "#compiler/ir/operations/call.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
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
import { CellRef } from "#compiler/ir/cell.js";
import { functionType } from "#compiler/ir/function.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";

test("resource operations expose their byte range, operands, and direct effects", () => {
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

  strictEqual(read.effect.resource, resource);
  strictEqual(read.effect.range, range);
  strictEqual(read.displacement, 6);
  deepStrictEqual(read.operands, [address]);
  deepStrictEqual(read.directEffects, {
    reads: [read.effect],
    writes: []
  });
  deepStrictEqual(write.operands, [address, stored]);
  deepStrictEqual(write.directEffects, {
    reads: [],
    writes: [write.effect]
  });
  deepStrictEqual(read.referencedResources, [resource]);
  deepStrictEqual(write.referencedResources, [resource]);
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

test("cell operations retain cell type, initialization, and effects", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");
  const wide = new CellRef("i64");
  const stored = values.parameter(0, "i32");
  const wideStored = values.parameter(1, "i64");
  const read = cellRead.create({ cell }, () => values.addNodeOutput());
  const wideRead = cellRead.create({ cell: wide }, () => values.addNodeOutput64());
  const write = cellWrite.create({
    cell,
    value: stored,
    initialization: "seed"
  });
  const wideWrite = cellWrite.create({
    cell: wide,
    value: wideStored,
    initialization: "update"
  });

  deepStrictEqual(read.results, [{ type: "i32" }]);
  deepStrictEqual(wideRead.results, [{ type: "i64" }]);
  deepStrictEqual(read.directEffects, {
    reads: [{ space: "cell", cell }],
    writes: []
  });
  deepStrictEqual(write.directEffects, {
    reads: [],
    writes: [{ space: "cell", cell }]
  });
  strictEqual(write.initialization, "seed");
  deepStrictEqual(wideWrite.inputs, [{ value: wideStored, type: "i64" }]);
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
  deepStrictEqual(operation.operands, [argument]);
  deepStrictEqual(operation.directEffects, target.effects);
  strictEqual(operation.outputs.length, 1);
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
  deepStrictEqual(operation.operands, [argument, elementIndex]);
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
