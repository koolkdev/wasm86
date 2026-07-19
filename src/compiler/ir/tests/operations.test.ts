import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import {
  emitOperation,
  type Operation
} from "#compiler/ir/operations/index.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import { CellRef } from "#compiler/refs/cell.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceRef
} from "#compiler/ir/resource.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";

test("every normalized operation constructs through its owner", () => {
  const address = valueId(1);
  const value = valueId(3);
  const cell = new CellRef("i32");
  const resource = resourceRef("test.resource");
  const range: ByteRange = {
    basis: { kind: "dynamic", origin: new DynamicByteOriginRef() }
  };
  const operations = [
    resourceRead.create({ source: byteOperand(resource, range, address, 4, 16) }),
    resourceWrite.create({
      destination: byteOperand(resource, range, address, 4, 16),
      value
    }),
    cellRead.create({ cell }),
    cellWrite.create({ cell, value, initialization: "seed" })
  ];

  deepStrictEqual(operations.map((operation) => operation.kind), [
    "resource.read",
    "resource.write",
    "cell.read",
    "cell.write"
  ]);
});

test("operation owners do not copy caller metadata", () => {
  const resource = resourceRef("test.metadata-resource");
  const args = {
    source: byteOperand(
      resource,
      { basis: { kind: "resource" } },
      valueId(0),
      0,
      32
    ),
    loweringMetadata: { kind: "unrelated" },
    callerMetadata: true
  };
  const operation = resourceRead.create(args);

  strictEqual("loweringMetadata" in operation, false);
  strictEqual("callerMetadata" in operation, false);
});

test("operation inputs are the complete semantic dependencies", () => {
  const address = valueId(21);
  const value = valueId(24);
  const resource = resourceRef("test.inputs-resource");
  const range: ByteRange = { basis: { kind: "resource" } };

  deepStrictEqual(
    resourceRead.create({
      source: byteOperand(resource, range, address, 0, 32)
    }).inputs,
    [{ value: address, type: "i32" }]
  );
  deepStrictEqual(
    resourceWrite.create({
      destination: byteOperand(resource, range, address, 0, 32),
      value
    }).inputs,
    [
      { value: address, type: "i32" },
      { value, type: "i32" }
    ]
  );
});

test("operation emission consumes every declared input position once", () => {
  const address = valueId(31);
  const value = valueId(33);
  const cell = new CellRef("i32");
  const target = {
    body: new WasmFunctionBodyEncoder(),
    cellLocal: () => 0,
    resourceIndex: () => 0
  };

  function emittedUses(operation: Operation) {
    const uses: ValueId[] = [];

    emitOperation(target, {
      emitUse: (id) => uses.push(id),
      constValue: () => undefined
    }, operation);
    return uses;
  }

  const resource = resourceRef("test.emission-resource");
  const range: ByteRange = { basis: { kind: "resource" } };

  deepStrictEqual(
    emittedUses(resourceRead.create({
      source: byteOperand(resource, range, address, 0, 32)
    })),
    [address]
  );
  deepStrictEqual(
    emittedUses(resourceWrite.create({
      destination: byteOperand(resource, range, address, 0, 32),
      value
    })),
    [address, value]
  );
  deepStrictEqual(emittedUses(cellRead.create({ cell })), []);
  deepStrictEqual(
    emittedUses(cellWrite.create({ cell, value, initialization: "update" })),
    [value]
  );
});

test("resource definitions retain identities, ranges, and indexed memory facts", () => {
  const resource = resourceRef("test.generic-memory");
  const origin = new DynamicByteOriginRef();
  const range: ByteRange = {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset: 6, byteLength: 2 }
  };
  const address = valueId(50);
  const value = valueId(51);
  const read = resourceRead.create({
    source: byteOperand(resource, range, address, 6, 16),
    mode: { kind: "signed" }
  });
  const write = resourceWrite.create({
    destination: byteOperand(resource, range, address, 6, 16),
    value
  });

  deepStrictEqual(read.result, { type: "i32", bounds: signExtended(16) });
  deepStrictEqual(read.inputs, [{ value: address, type: "i32" }]);
  deepStrictEqual(read.effect, { space: "resource", resource, range });
  strictEqual(read.displacement, 6);
  deepStrictEqual(read.effects, {
    reads: [read.effect],
    writes: []
  });
  strictEqual(read.effects.reads[0], read.effect);
  deepStrictEqual(write.result, undefined);
  deepStrictEqual(write.inputs, [
    { value: address, type: "i32" },
    { value, type: "i32" }
  ]);
  deepStrictEqual(write.effect, { space: "resource", resource, range });
  strictEqual(write.displacement, 6);
  deepStrictEqual(write.effects, {
    reads: [],
    writes: [write.effect]
  });
  strictEqual(write.effects.writes[0], write.effect);

  const body = new WasmFunctionBodyEncoder();
  const target = {
    body,
    cellLocal: () => {
      throw new Error("resource operation requested a cell local");
    },
    resourceIndex: (candidate: typeof resource) => {
      strictEqual(candidate, resource);
      return 3;
    }
  };
  const emitter = {
    emitUse: () => body.i32Const(0),
    constValue: () => undefined
  };

  emitOperation(target, emitter, read);
  body.drop();
  emitOperation(target, emitter, write);
  deepStrictEqual(body.finish().references.memoryIndices, [3]);
});

test("resource-read modes derive their result bounds", () => {
  const resource = resourceRef("test.refined-read");
  const source = byteOperand(
    resource,
    { basis: { kind: "resource" }, slice: { byteOffset: 0, byteLength: 1 } },
    valueId(0),
    0,
    8
  );

  deepStrictEqual(resourceRead.create({ source }).result, {
    type: "i32",
    bounds: fitsUnsigned(8)
  });
  deepStrictEqual(
    resourceRead.create({
      source,
      mode: { kind: "unsigned", bounds: fitsUnsigned(1) }
    }).result,
    { type: "i32", bounds: fitsUnsigned(1) }
  );
  deepStrictEqual(
    resourceRead.create({ source, mode: { kind: "signed" } }).result,
    { type: "i32", bounds: signExtended(8) }
  );
  throws(
    () => resourceRead.create({
      source: { ...source, width: 32 },
      mode: { kind: "signed" }
    }),
    /32-bit resource read has no signed extension/
  );
});

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

test("typed cell definitions expose exact identity effects", () => {
  const value = valueId(6);
  const cell = new CellRef("i32");
  const other = new CellRef("i32");
  const wide = new CellRef("i64");
  const read = cellRead.create({ cell });
  const write = cellWrite.create({ cell, value, initialization: "seed" });

  deepStrictEqual(read.inputs, []);
  deepStrictEqual(read.result, { type: "i32" });
  deepStrictEqual(read.effects, { reads: [{ space: "cell", cell }], writes: [] });
  deepStrictEqual(write.inputs, [{ value, type: "i32" }]);
  deepStrictEqual(write.result, undefined);
  deepStrictEqual(write.effects, { reads: [], writes: [{ space: "cell", cell }] });
  deepStrictEqual(cellRead.create({ cell: other }).effects, {
    reads: [{ space: "cell", cell: other }],
    writes: []
  });
  deepStrictEqual(cellRead.create({ cell: wide }).result, { type: "i64" });
  deepStrictEqual(
    cellWrite.create({ cell: wide, value, initialization: "update" }).inputs,
    [{ value, type: "i64" }]
  );
});
