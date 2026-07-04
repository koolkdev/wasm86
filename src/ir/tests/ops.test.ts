import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  opAccess,
  opMutates,
  opReads,
  opValueInputs,
  opValueOutput,
  opWrites,
  type IrOp,
  type StorageAccess
} from "#ir/ops.js";
import {
  flagChannel,
  gprChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentSelectorChannel,
  type StateSlot
} from "#ir/slots.js";
import { fitsUnsigned, signExtended } from "#ir/values.js";

const memory: StorageAccess = { space: "memory" };
const memoryBounds: StorageAccess = { space: "memoryBounds" };

function state(slot: StateSlot): StorageAccess {
  return { space: "state", slot };
}

test("state reads expose semantic slot inputs and storage reads", () => {
  const index = 7;
  const dynamicByte: StateSlot = { kind: "gprDynamic", index, byteLength: 1 };
  const dynamicSegment: StateSlot = { kind: "segmentDynamic", index, field: "selector" };

  deepStrictEqual(opValueInputs({ kind: "state.read", slot: gprChannel("eax") }), []);
  deepStrictEqual(opReads({ kind: "state.read", slot: gprChannel("eax") }), [state(gprChannel("eax"))]);
  deepStrictEqual(opValueInputs({ kind: "state.read", slot: dynamicByte }), [index]);
  deepStrictEqual(opReads({ kind: "state.read", slot: dynamicByte }), [state(dynamicByte)]);
  deepStrictEqual(opValueInputs({ kind: "state.read", slot: dynamicSegment }), [index]);
  deepStrictEqual(opReads({ kind: "state.read", slot: dynamicSegment }), [state(dynamicSegment)]);
});

test("byte dynamic GPR access lists its index once", () => {
  const index = 3;
  const value = 9;
  const slot: StateSlot = { kind: "gprDynamic", index, byteLength: 1 };

  deepStrictEqual(opValueInputs({ kind: "state.read", slot }), [index]);
  deepStrictEqual(opValueInputs({ kind: "state.write", slot, value }), [index, value]);
});

test("state writes order slot operands before the written value", () => {
  const index = 4;
  const value = 12;
  const dynamicSegment: StateSlot = { kind: "segmentDynamic", index, field: "base" };

  deepStrictEqual(opValueInputs({ kind: "state.write", slot: gprChannel("ecx"), value }), [value]);
  deepStrictEqual(opValueInputs({ kind: "state.write", slot: dynamicSegment, value }), [index, value]);
  deepStrictEqual(opWrites({ kind: "state.write", slot: dynamicSegment, value }), [state(dynamicSegment)]);
  strictEqual(opMutates({ kind: "state.write", slot: dynamicSegment, value }), true);
});

test("memory ops expose address/value inputs and memory storage access", () => {
  const address = 5;
  const value = 6;

  deepStrictEqual(opAccess({ kind: "memory.read", address, width: 32 }), {
    valueInputs: [address],
    valueOutput: { type: "i32" },
    reads: [memory],
    writes: []
  });
  deepStrictEqual(opAccess({ kind: "memory.write", address, value, width: 32 }), {
    valueInputs: [address, value],
    reads: [],
    writes: [memory]
  });
  strictEqual(opMutates({ kind: "memory.read", address, width: 32 }), false);
  strictEqual(opMutates({ kind: "memory.write", address, value, width: 32 }), true);
});

test("memory.check observes memory bounds and produces a boolean predicate", () => {
  const address = 5;

  deepStrictEqual(opAccess({ kind: "memory.check", address, byteLength: 4, access: "read" }), {
    valueInputs: [address],
    valueOutput: { type: "i32", bounds: fitsUnsigned(1) },
    reads: [memoryBounds],
    writes: []
  });
  strictEqual(opMutates({ kind: "memory.check", address, byteLength: 4, access: "write" }), false);
});

test("cpu.resolveFlag exposes lazy flag channel reads and a boolean output", () => {
  deepStrictEqual(opAccess({ kind: "cpu.resolveFlag", flag: "ZF" }), {
    valueInputs: [],
    valueOutput: { type: "i32", bounds: fitsUnsigned(1) },
    reads: [
      state(flagChannel("ZF")),
      state(lazyFlagsKindChannel),
      state(lazyFlagsAChannel),
      state(lazyFlagsBChannel)
    ],
    writes: []
  });
  strictEqual(opMutates({ kind: "cpu.resolveFlag", flag: "ZF" }), false);
});

test("op output bounds match narrow and signed reads", () => {
  const unsignedByteRead: IrOp = { kind: "state.read", slot: gprChannel("al") };
  const signedByteRead: IrOp = { kind: "state.read", slot: gprChannel("al"), signed: true };
  const unsignedMemoryRead: IrOp = { kind: "memory.read", address: 1, width: 16 };
  const signedMemoryRead: IrOp = { kind: "memory.read", address: 1, width: 16, signed: true };

  deepStrictEqual(opValueOutput(unsignedByteRead), { type: "i32", bounds: fitsUnsigned(8) });
  deepStrictEqual(opValueOutput(signedByteRead), { type: "i32", bounds: signExtended(8) });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: flagChannel("ZF") }), {
    type: "i32",
    bounds: fitsUnsigned(1)
  });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: lazyFlagsKindChannel }), {
    type: "i32",
    bounds: fitsUnsigned(8)
  });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: lazyFlagsAChannel, accessByteLength: 1 }), {
    type: "i32",
    bounds: fitsUnsigned(8)
  });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: lazyFlagsAChannel, signed: true, accessByteLength: 2 }), {
    type: "i32",
    bounds: signExtended(16)
  });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: segmentSelectorChannel("fs") }), {
    type: "i32",
    bounds: fitsUnsigned(16)
  });
  deepStrictEqual(opValueOutput(unsignedMemoryRead), { type: "i32", bounds: fitsUnsigned(16) });
  deepStrictEqual(opValueOutput(signedMemoryRead), { type: "i32", bounds: signExtended(16) });
  deepStrictEqual(opValueOutput({ kind: "memory.read", address: 1, width: 32, signed: true }), { type: "i32" });
  strictEqual(opValueOutput({ kind: "state.write", slot: gprChannel("eax"), value: 1 }), undefined);
});
