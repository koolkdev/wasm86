import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  memoryCheck,
  memoryRead,
  memoryResolve,
  memoryWrite
} from "#compiler/ir/operations/memory.js";
import { resolveFlag } from "#compiler/ir/operations/resolve-flag.js";
import { stateRead, stateWrite } from "#compiler/ir/operations/state.js";
import { varRead, varWrite } from "#compiler/ir/operations/variables.js";
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
  const operations = [
    stateRead.create({ slot }),
    stateWrite.create({ slot, value }),
    memoryRead.create({ address, byteOffset: 4, width: 16 }),
    memoryWrite.create({ address, byteOffset: 4, value, width: 16 }),
    memoryCheck.create({ address, byteLength }),
    memoryResolve.create({ address, byteLength }),
    resolveFlag.create({ flag: "ZF" }),
    varRead.create({ variable: 4 }),
    varWrite.create({ variable: 4, value })
  ];

  deepStrictEqual(operations.map((operation) => operation.kind), [
    "state.read",
    "state.write",
    "memory.read",
    "memory.write",
    "memory.check",
    "memory.resolve",
    "cpu.resolveFlag",
    "var.read",
    "var.write"
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

test("dynamic state definitions expose each semantic input exactly once", () => {
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

test("semantic var definitions validate their index and expose exact effects", () => {
  const value = valueId(6);

  const read = varRead.create({ variable: 2 });
  const write = varWrite.create({ variable: 2, value });

  deepStrictEqual(read.inputs, []);
  deepStrictEqual(read.result, { type: "i32" });
  deepStrictEqual(read.effects, { reads: [{ space: "var", variable: 2 }], writes: [] });
  deepStrictEqual(write.inputs, [{ value, type: "i32" }]);
  deepStrictEqual(write.result, undefined);
  deepStrictEqual(write.effects, { reads: [], writes: [{ space: "var", variable: 2 }] });
  throws(
    () => varRead.create({ variable: -1 }),
    /var\.read op has an invalid semantic var index/
  );
  throws(
    () => varWrite.create({ variable: 1.5, value }),
    /var\.write op has an invalid semantic var index/
  );
});
