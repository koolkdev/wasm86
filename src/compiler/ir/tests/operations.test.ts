import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  IndirectCallTarget,
  Invocation,
  type CallTarget
} from "#compiler/ir/invocation.js";
import { callOperation } from "#compiler/ir/operations/call.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import type {
  Operation,
  OperationEmitTarget,
  OperationResult
} from "#compiler/ir/operations/index.js";
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
import { valueId } from "#compiler/ir/values/id.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import { CellRef } from "#compiler/refs/cell.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef, tableRef } from "#compiler/program/refs.js";

test("operation owners atomically construct complete occurrences", () => {
  const address = valueId(1);
  const value = valueId(3);
  const readOutput = valueId(4);
  const cellOutput = valueId(5);
  const cell = new CellRef("i32");
  const resource = resourceRef("test.resource");
  const range: ByteRange = {
    basis: { kind: "dynamic", origin: new DynamicByteOriginRef() }
  };
  const allocations: OperationResult[] = [];
  const allocate = (output: ValueId) =>
    (result: OperationResult): ValueId => {
      allocations.push(result);
      return output;
    };
  const operations: readonly Operation[] = [
    resourceRead.create(
      { source: byteOperand(resource, range, address, 4, 16) },
      allocate(readOutput)
    ),
    resourceWrite.create(
      {
        destination: byteOperand(resource, range, address, 4, 16),
        value
      }
    ),
    cellRead.create({ cell }, allocate(cellOutput)),
    cellWrite.create({ cell, value, initialization: "seed" })
  ];

  deepStrictEqual(operations.map((operation) => operation.kind), [
    "resource.read",
    "resource.write",
    "cell.read",
    "cell.write"
  ]);
  deepStrictEqual(operations.map((operation) => operation.category), [
    "operation",
    "operation",
    "operation",
    "operation"
  ]);
  deepStrictEqual(operations.map((operation) => operation.outputs), [
    [readOutput],
    [],
    [cellOutput],
    []
  ]);
  deepStrictEqual(operations.map((operation) => operation.referencedResources), [
    [resource],
    [resource],
    [],
    []
  ]);
  deepStrictEqual(allocations, [
    { type: "i32", bounds: fitsUnsigned(16) },
    { type: "i32" }
  ]);
  strictEqual("node" in operations[0]!, false);
});

test("operation owners normalize only declared fields and expose direct facts", () => {
  const resource = resourceRef("test.metadata-resource");
  const address = valueId(10);
  const output = valueId(11);
  const args = {
    source: byteOperand(
      resource,
      { basis: { kind: "resource" } },
      address,
      0,
      32
    ),
    loweringMetadata: { kind: "unrelated" },
    callerMetadata: true
  };
  const operation = resourceRead.create(args, () => output);

  strictEqual("loweringMetadata" in operation, false);
  strictEqual("callerMetadata" in operation, false);
  deepStrictEqual(operation.inputs, [{ value: address, type: "i32" }]);
  deepStrictEqual(operation.operands, [address]);
  deepStrictEqual(operation.outputs, [output]);
  deepStrictEqual(operation.nestedBodies, []);
  strictEqual(operation.completes({ bodyCompletes: () => true }), false);
  strictEqual(operation.mapBodies(() => ({ nodes: [] })), operation);
  deepStrictEqual(operation.directEffects, {
    reads: [operation.effect],
    writes: []
  });
  deepStrictEqual(operation.referencedResources, [resource]);
});

test("resource operations retain identities, ranges, and result refinements", () => {
  const resource = resourceRef("test.generic-memory");
  const origin = new DynamicByteOriginRef();
  const range: ByteRange = {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset: 6, byteLength: 2 }
  };
  const address = valueId(20);
  const value = valueId(21);
  const output = valueId(22);
  const read = resourceRead.create(
    {
      source: byteOperand(resource, range, address, 6, 16),
      mode: { kind: "signed" }
    },
    () => output
  );
  const write = resourceWrite.create({
    destination: byteOperand(resource, range, address, 6, 16),
    value
  });

  deepStrictEqual(read.results, [{ type: "i32", bounds: signExtended(16) }]);
  deepStrictEqual(read.inputs, [{ value: address, type: "i32" }]);
  deepStrictEqual(read.effect, { space: "resource", resource, range });
  strictEqual(read.displacement, 6);
  deepStrictEqual(read.directEffects, { reads: [read.effect], writes: [] });
  strictEqual(read.directEffects.reads[0], read.effect);
  deepStrictEqual(write.results, []);
  deepStrictEqual(write.inputs, [
    { value: address, type: "i32" },
    { value, type: "i32" }
  ]);
  deepStrictEqual(write.directEffects, { reads: [], writes: [write.effect] });
  strictEqual(write.directEffects.writes[0], write.effect);

  const source = byteOperand(
    resource,
    { basis: { kind: "resource" } },
    address,
    0,
    8
  );
  deepStrictEqual(
    resourceRead.create({ source }, () => output).results,
    [{ type: "i32", bounds: fitsUnsigned(8) }]
  );
  deepStrictEqual(
    resourceRead.create(
      { source, mode: { kind: "unsigned", bounds: fitsUnsigned(1) } },
      () => output
    ).results,
    [{ type: "i32", bounds: fitsUnsigned(1) }]
  );
  throws(
    () => resourceRead.create(
      { source: { ...source, width: 32 }, mode: { kind: "signed" } },
      () => output
    ),
    /32-bit resource read has no signed extension/
  );
});

test("typed cell operations expose flat cell facts and exact effects", () => {
  const value = valueId(30);
  const output = valueId(31);
  const cell = new CellRef("i32");
  const wide = new CellRef("i64");
  const read = cellRead.create({ cell }, () => output);
  const write = cellWrite.create({ cell, value, initialization: "seed" });

  strictEqual(read.cell, cell);
  deepStrictEqual(read.results, [{ type: "i32" }]);
  deepStrictEqual(read.directEffects, { reads: [{ space: "cell", cell }], writes: [] });
  strictEqual(write.cell, cell);
  strictEqual(write.initialization, "seed");
  deepStrictEqual(write.operands, [value]);
  deepStrictEqual(write.directEffects, { reads: [], writes: [{ space: "cell", cell }] });
  deepStrictEqual(cellRead.create({ cell: wide }, () => output).results, [
    { type: "i64" }
  ]);
  deepStrictEqual(
    cellWrite.create({ cell: wide, value, initialization: "update" }).inputs,
    [{ value, type: "i64" }]
  );
});

test("ordinary calls are operations with allocator-owned outputs and direct emission", () => {
  const argument = valueId(40);
  const output = valueId(41);
  const targetFunction = functionDefinition("test.call", ["i32"], ["i32"]);
  const invocation = Invocation.create({
    target: targetFunction,
    arguments: [{ value: argument, type: "i32" }]
  });
  const operation = callOperation.create(
    { invocation },
    (result) => {
      deepStrictEqual(result, { type: "i32" });
      return output;
    }
  );
  const body = new WasmFunctionBodyEncoder();
  const uses: ValueId[] = [];

  operation.emit(operationTarget(body, targetFunction), {
    emitUse(value) {
      uses.push(value);
      body.i32Const(value);
    }
  });

  strictEqual(operation.category, "operation");
  strictEqual(operation.invocation, invocation);
  strictEqual(invocation.target, targetFunction);
  deepStrictEqual(operation.operands, [argument]);
  deepStrictEqual(operation.outputs, [output]);
  deepStrictEqual(operation.directEffects, targetFunction.effects);
  deepStrictEqual(operation.referencedResources, []);
  deepStrictEqual(uses, [argument]);
  const encoded = body.finish();

  deepStrictEqual(encoded.references.functionIndices, [7]);
  deepStrictEqual(wasmBodyOpcodes(encoded.bytes), [
    wasmOpcode.i32Const,
    wasmOpcode.call,
    wasmOpcode.end
  ]);
  throws(
    () => Invocation.create({
      target: targetFunction,
      arguments: []
    }),
    /expects 1 arguments, got 0/
  );
  const multiResultTarget = functionDefinition(
    "test.call-multi-result",
    [],
    ["i32", "i64"]
  );

  throws(
    () => callOperation.create(
      {
        invocation: Invocation.create({
          target: multiResultTarget,
          arguments: []
        })
      },
      () => output
    ),
    /multiple call results are not supported yet/
  );
});

test("call targets are structurally polymorphic", () => {
  const elementIndex = valueId(45);
  const table = tableRef("test.structural-call-table");
  const type = functionType([], []);
  const effects = { reads: [], writes: [] } as const;
  const target = {
    type,
    effects,
    targetInputs: [{ value: elementIndex, type: "i32" }] as const,
    references: { functions: [], types: [type], tables: [table] },
    emitCall(context) {
      context.body.callIndirect(
        context.typeIndex(type),
        context.tableIndex(table)
      );
    },
    emitReturnCall(context) {
      context.body.returnCallIndirect(
        context.typeIndex(type),
        context.tableIndex(table)
      );
    }
  } satisfies CallTarget;
  const invocation = Invocation.create({ target, arguments: [] });

  strictEqual(invocation.target, target);
  deepStrictEqual(invocation.inputs, [
    { value: elementIndex, type: "i32" }
  ]);
  deepStrictEqual(target.references, {
    functions: [],
    types: [type],
    tables: [table]
  });
});

test("indirect invocations own their selector, effects, and emission", () => {
  const argument = valueId(50);
  const elementIndex = valueId(51);
  const output = valueId(52);
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
  const operation = callOperation.create({ invocation }, () => output);
  const body = new WasmFunctionBodyEncoder();
  const uses: ValueId[] = [];

  operation.emit({
    body,
    cellLocal: () => 0,
    resourceIndex: () => 0,
    functionIndex: () => {
      throw new Error("indirect call requested a direct function index");
    },
    typeIndex(candidate) {
      strictEqual(candidate, type);
      return 8;
    },
    tableIndex(candidate) {
      strictEqual(candidate, table);
      return 9;
    }
  }, {
    emitUse(value) {
      uses.push(value);
      body.i32Const(value);
    }
  });

  deepStrictEqual(invocation.arguments, [{ value: argument, type: "i64" }]);
  deepStrictEqual(invocation.inputs, [
    { value: argument, type: "i64" },
    { value: elementIndex, type: "i32" }
  ]);
  strictEqual(invocation.target, target);
  strictEqual(target.type, type);
  strictEqual(target.effects, effects);
  deepStrictEqual(target.targetInputs, [
    { value: elementIndex, type: "i32" }
  ]);
  deepStrictEqual(target.references, {
    functions: [],
    types: [type],
    tables: [table]
  });
  deepStrictEqual(operation.operands, [argument, elementIndex]);
  deepStrictEqual(operation.outputs, [output]);
  deepStrictEqual(uses, [argument, elementIndex]);
  const encoded = body.finish();

  deepStrictEqual(encoded.references.typeIndices, [8]);
  deepStrictEqual(encoded.references.tableIndices, [9]);
  strictEqual(encoded.bytes.includes(wasmOpcode.callIndirect), true);
  throws(
    () => Invocation.create({
      target: IndirectCallTarget.create({
        table,
        type,
        effects,
        elementIndex: { value: elementIndex, type: "i64" }
      }),
      arguments: [{ value: argument, type: "i64" }]
    }),
    /table element index must be i32, got i64/
  );
});

test("resource and cell emission call their definition-specific target services", () => {
  const resource = resourceRef("test.emission-resource");
  const range: ByteRange = { basis: { kind: "resource" } };
  const address = valueId(60);
  const value = valueId(61);
  const output = valueId(62);
  const cell = new CellRef("i32");
  const body = new WasmFunctionBodyEncoder();
  const target: OperationEmitTarget = {
    body,
    cellLocal(candidate) {
      strictEqual(candidate, cell);
      return 2;
    },
    resourceIndex(candidate) {
      strictEqual(candidate, resource);
      return 3;
    },
    functionIndex: () => {
      throw new Error("non-call operation requested a function index");
    },
    typeIndex: () => {
      throw new Error("non-call operation requested a type index");
    },
    tableIndex: () => {
      throw new Error("non-call operation requested a table index");
    }
  };
  const uses: ValueId[] = [];
  const values = {
    emitUse(id: ValueId) {
      uses.push(id);
      body.i32Const(0);
    }
  };

  resourceRead.create(
    { source: byteOperand(resource, range, address, 0, 32) },
    () => output
  ).emit(target, values);
  body.drop();
  resourceWrite.create({
    destination: byteOperand(resource, range, address, 0, 32),
    value
  }).emit(target, values);
  cellRead.create({ cell }, () => output).emit(target, values);
  body.drop();
  cellWrite.create({ cell, value, initialization: "update" }).emit(target, values);

  deepStrictEqual(uses, [address, address, value, value]);
  deepStrictEqual(body.finish().references.memoryIndices, [3]);
});

function operationTarget(
  body: WasmFunctionBodyEncoder,
  expectedFunction?: FunctionDefinition
): OperationEmitTarget {
  return {
    body,
    cellLocal: () => 0,
    resourceIndex: () => 0,
    functionIndex(candidate) {
      strictEqual(candidate, expectedFunction);
      return 7;
    },
    typeIndex: () => 0,
    tableIndex: () => 0
  };
}

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
