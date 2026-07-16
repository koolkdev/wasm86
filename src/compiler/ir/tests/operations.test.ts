import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import {
  emitOperation,
  type Operation
} from "#compiler/ir/operations/index.js";
import {
  memoryCheck,
  memoryRead,
  memoryResolve,
  memoryWrite
} from "#compiler/ir/operations/memory.js";
import { resolveFlag } from "#compiler/ir/operations/resolve-flag.js";
import { stateRead, stateWrite } from "#compiler/ir/operations/state.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import { CellRef } from "#compiler/refs/cell.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { WidthBounds } from "#compiler/ir/values/types.js";
import {
  flagChannel,
  gprChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentAccessChannel,
  segmentLimitChannel,
  segmentSelectorChannel,
  type StateSlot
} from "#ir/slots.js";

test("every operation constructs through its owner", () => {
  const slot = gprChannel("eax");
  const address = valueId(1);
  const byteLength = valueId(2);
  const value = valueId(3);
  const cell = new CellRef("i32");
  const operations = [
    stateRead.create({ slot }),
    stateWrite.create({ slot, value }),
    memoryRead.create({ address, byteOffset: 4, width: 16 }),
    memoryWrite.create({ address, byteOffset: 4, value, width: 16 }),
    memoryCheck.create({ address, byteLength }),
    memoryResolve.create({ address, byteLength }),
    resolveFlag.create({ flag: "ZF" }),
    cellRead.create({ cell }),
    cellWrite.create({ cell, value, initialization: "seed" })
  ];

  deepStrictEqual(operations.map((operation) => operation.kind), [
    "state.read",
    "state.write",
    "memory.read",
    "memory.write",
    "memory.check",
    "memory.resolve",
    "cpu.resolveFlag",
    "cell.read",
    "cell.write"
  ]);
});

test("operation owners do not copy caller metadata", () => {
  const args = {
    slot: gprChannel("eax"),
    helper: { kind: "lazyFlag", flag: "ZF" },
    callerMetadata: true
  };
  const operation = stateRead.create(args);

  strictEqual(operation.helper, undefined);
  strictEqual("callerMetadata" in operation, false);
});

test("dynamic byte state definitions expose each semantic input once", () => {
  const index = valueId(7);
  const value = valueId(8);
  const slot: StateSlot = { kind: "gprDynamic", index, byteLength: 1 };

  const read = stateRead.create({ slot });
  const write = stateWrite.create({ slot, value });

  deepStrictEqual(read.inputs, [{ value: index, type: "i32" }]);
  deepStrictEqual(read.result, { type: "i32", bounds: fitsUnsigned(8) });
  deepStrictEqual(read.effects, { reads: [{ space: "state", slot }], writes: [] });
  deepStrictEqual(read.helper, undefined);
  deepStrictEqual(write.inputs, [
    { value: index, type: "i32" },
    { value, type: "i32" }
  ]);
  deepStrictEqual(write.result, undefined);
  deepStrictEqual(write.effects, { reads: [], writes: [{ space: "state", slot }] });
  deepStrictEqual(write.helper, undefined);
});

test("operation inputs are the complete semantic dependencies", () => {
  const index = valueId(20);
  const address = valueId(21);
  const byteLength = valueId(22);
  const value = valueId(24);
  const wordSlot: StateSlot = { kind: "gprDynamic", index, byteLength: 2 };

  deepStrictEqual(
    stateRead.create({ slot: wordSlot }).inputs,
    [{ value: index, type: "i32" }]
  );
  deepStrictEqual(
    stateWrite.create({ slot: wordSlot, value }).inputs,
    [
      { value: index, type: "i32" },
      { value, type: "i32" }
    ]
  );
  deepStrictEqual(
    memoryCheck.create({ address, byteLength }).inputs,
    [
      { value: address, type: "i32" },
      { value: byteLength, type: "i32" }
    ]
  );
  deepStrictEqual(
    memoryResolve.create({ address, byteLength }).inputs,
    [
      { value: address, type: "i32" },
      { value: byteLength, type: "i32" }
    ]
  );
  deepStrictEqual(
    memoryWrite.create({ address, byteOffset: 0, value, width: 32 }).inputs,
    [
      { value: address, type: "i32" },
      { value, type: "i32" }
    ]
  );
});

test("operation emission consumes every declared input position once", () => {
  const index = valueId(30);
  const address = valueId(31);
  const byteLength = valueId(32);
  const value = valueId(33);
  const cell = new CellRef("i32");
  const target = {
    body: new WasmFunctionBodyEncoder(),
    withTemporaryLocal: (_type: "i32" | "i64", callback: (local: number) => void) => {
      callback(0);
    },
    cellLocal: () => 0,
    helperFunctionIndex: () => 0
  };

  function emittedUses(operation: Operation) {
    const uses: typeof index[] = [];

    emitOperation(target, {
      emitUse: (id) => uses.push(id),
      constValue: () => undefined
    }, operation);
    return uses;
  }

  deepStrictEqual(
    emittedUses(memoryCheck.create({ address, byteLength })),
    [byteLength, address]
  );
  deepStrictEqual(
    emittedUses(memoryResolve.create({ address, byteLength })),
    [byteLength, address]
  );
  deepStrictEqual(
    emittedUses(stateRead.create({
      slot: { kind: "gprDynamic", index, byteLength: 1 }
    })),
    [index]
  );
  deepStrictEqual(
    emittedUses(stateWrite.create({
      slot: { kind: "gprDynamic", index, byteLength: 1 },
      value
    })),
    [index, value]
  );
  deepStrictEqual(
    emittedUses(memoryRead.create({ address, byteOffset: 0, width: 32 })),
    [address]
  );
  deepStrictEqual(emittedUses(cellRead.create({ cell })), []);
  deepStrictEqual(
    emittedUses(cellWrite.create({ cell, value, initialization: "update" })),
    [value]
  );
});

test("a folded operation input needs neither emission nor a temporary", () => {
  const address = valueId(40);
  const byteLength = valueId(41);
  const uses: typeof address[] = [];
  let requestedTemporary = false;

  emitOperation({
    body: new WasmFunctionBodyEncoder(),
    withTemporaryLocal: (_type, callback) => {
      requestedTemporary = true;
      callback(0);
    },
    cellLocal: () => 0,
    helperFunctionIndex: () => 0
  }, {
    emitUse: (id) => uses.push(id),
    constValue: (id) => id === byteLength ? 4 : undefined
  }, memoryCheck.create({ address, byteLength }));

  deepStrictEqual(uses, [address]);
  strictEqual(requestedTemporary, false);
});

test("a static memory check rejects an empty range", () => {
  const address = valueId(42);
  const byteLength = valueId(43);

  throws(
    () => emitOperation({
      body: new WasmFunctionBodyEncoder(),
      withTemporaryLocal: () => {
        throw new Error("static check requested a temporary");
      },
      cellLocal: () => 0,
      helperFunctionIndex: () => 0
    }, {
      emitUse: () => {},
      constValue: (id) => id === byteLength ? 0 : undefined
    }, memoryCheck.create({ address, byteLength })),
    /guest access byte length must be positive, got 0/
  );
});

test("state read bounds retain access width and signedness", () => {
  const index = valueId(9);
  const cases: readonly [StateSlot, Readonly<{ signed?: true; accessByteLength?: 1 | 2 }>, WidthBounds | undefined][] = [
    [gprChannel("al"), {}, fitsUnsigned(8)],
    [gprChannel("al"), { signed: true }, signExtended(8)],
    [flagChannel("CF"), {}, fitsUnsigned(1)],
    [lazyFlagsKindChannel, {}, fitsUnsigned(8)],
    [lazyFlagsAChannel, { accessByteLength: 1 }, fitsUnsigned(8)],
    [lazyFlagsAChannel, { signed: true, accessByteLength: 2 }, signExtended(16)],
    [segmentSelectorChannel("fs"), {}, fitsUnsigned(16)],
    [segmentLimitChannel("fs"), {}, undefined],
    [segmentAccessChannel("fs"), {}, undefined],
    [{ kind: "segmentDynamic", index, field: "limit" }, {}, undefined]
  ];

  for (const [slot, options, bounds] of cases) {
    const result = stateRead.create({ slot, ...options }).result;

    deepStrictEqual(result, bounds === undefined ? { type: "i32" } : { type: "i32", bounds });
  }
});

test("memory definitions expose typed inputs, effects, and results", () => {
  const address = valueId(3);
  const byteLength = valueId(4);
  const value = valueId(5);

  const read = memoryRead.create({
    address,
    byteOffset: 6,
    width: 16,
    signed: true
  });
  const write = memoryWrite.create({
    address,
    byteOffset: 6,
    value,
    width: 32
  });

  deepStrictEqual(read.inputs, [{ value: address, type: "i32" }]);
  deepStrictEqual(read.result, { type: "i32", bounds: signExtended(16) });
  deepStrictEqual(read.effects, { reads: [{ space: "memory" }], writes: [] });
  deepStrictEqual(write.inputs, [
    { value: address, type: "i32" },
    { value, type: "i32" }
  ]);
  deepStrictEqual(write.result, undefined);
  deepStrictEqual(write.effects, { reads: [], writes: [{ space: "memory" }] });

  const expectedMemoryBoundsUse = {
    inputs: [
      { value: address, type: "i32" },
      { value: byteLength, type: "i32" }
    ],
    result: { type: "i32", bounds: fitsUnsigned(1) },
    effects: { reads: [{ space: "memoryBounds" }], writes: [] },
    helper: undefined
  };

  const check = memoryCheck.create({ address, byteLength });
  const resolve = memoryResolve.create({ address, byteLength });

  deepStrictEqual({
    inputs: check.inputs,
    result: check.result,
    effects: check.effects,
    helper: check.helper
  }, expectedMemoryBoundsUse);
  deepStrictEqual({
    inputs: resolve.inputs,
    result: resolve.result,
    effects: resolve.effects,
    helper: resolve.helper
  }, expectedMemoryBoundsUse);
  deepStrictEqual(
    memoryRead.create({ address, byteOffset: 0, width: 32, signed: true }).result,
    { type: "i32" }
  );
  throws(
    () => memoryRead.create({ address, byteOffset: -1, width: 8 }),
    /memory\.read byte offset must be an unsigned 32-bit integer/
  );
  throws(
    () => memoryWrite.create({ address, byteOffset: 1.5, value, width: 8 }),
    /memory\.write byte offset must be an unsigned 32-bit integer/
  );
});

test("flag resolution declares state reads and its helper call", () => {
  const operation = resolveFlag.create({ flag: "ZF" });

  deepStrictEqual(operation.inputs, []);
  deepStrictEqual(operation.result, { type: "i32", bounds: fitsUnsigned(1) });
  deepStrictEqual(operation.effects, {
    reads: [
      { space: "state", slot: flagChannel("ZF") },
      { space: "state", slot: lazyFlagsKindChannel },
      { space: "state", slot: lazyFlagsAChannel },
      { space: "state", slot: lazyFlagsBChannel }
    ],
    writes: []
  });
  deepStrictEqual(operation.helper, { kind: "lazyFlag", flag: "ZF" });
});

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
