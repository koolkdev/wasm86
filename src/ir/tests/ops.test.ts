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
  segmentAccessChannel,
  segmentLimitChannel,
  segmentSelectorChannel,
  type StateSlot
} from "#ir/slots.js";
import { valueId } from "#compiler/ir/values/id.js";
import {
  fitsUnsigned,
  signExtended
} from "#compiler/ir/values/width-bounds.js";

const memory: StorageAccess = { space: "memory" };
const memoryBounds: StorageAccess = { space: "memoryBounds" };

function state(slot: StateSlot): StorageAccess {
  return { space: "state", slot };
}

test("state reads expose semantic slot inputs and storage reads", () => {
  const index = valueId(7);
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
  const index = valueId(3);
  const value = valueId(9);
  const slot: StateSlot = { kind: "gprDynamic", index, byteLength: 1 };

  deepStrictEqual(opValueInputs({ kind: "state.read", slot }), [index]);
  deepStrictEqual(opValueInputs({ kind: "state.write", slot, value }), [index, value]);
});

test("state writes order slot operands before the written value", () => {
  const index = valueId(4);
  const value = valueId(12);
  const dynamicSegment: StateSlot = { kind: "segmentDynamic", index, field: "base" };

  deepStrictEqual(opValueInputs({ kind: "state.write", slot: gprChannel("ecx"), value }), [value]);
  deepStrictEqual(opValueInputs({ kind: "state.write", slot: dynamicSegment, value }), [index, value]);
  deepStrictEqual(opWrites({ kind: "state.write", slot: dynamicSegment, value }), [state(dynamicSegment)]);
  strictEqual(opMutates({ kind: "state.write", slot: dynamicSegment, value }), true);
});

test("every dynamic segment field lists its index exactly once", () => {
  const index = valueId(4);
  const value = valueId(12);

  for (const field of ["selector", "base", "limit", "access"] as const) {
    const slot: StateSlot = { kind: "segmentDynamic", index, field };

    deepStrictEqual(opValueInputs({ kind: "state.read", slot }), [index]);
    deepStrictEqual(opValueInputs({ kind: "state.write", slot, value }), [index, value]);
  }
});

test("memory ops expose address/value inputs and memory storage access", () => {
  const address = valueId(5);
  const value = valueId(6);

  deepStrictEqual(opAccess({ kind: "memory.read", address, byteOffset: 0, width: 32 }), {
    valueInputs: [address],
    valueOutput: { type: "i32" },
    reads: [memory],
    writes: []
  });
  deepStrictEqual(opAccess({ kind: "memory.write", address, byteOffset: 0, value, width: 32 }), {
    valueInputs: [address, value],
    reads: [],
    writes: [memory]
  });
  strictEqual(opMutates({ kind: "memory.read", address, byteOffset: 0, width: 32 }), false);
  strictEqual(opMutates({ kind: "memory.write", address, byteOffset: 0, value, width: 32 }), true);
});

test("var ops expose the var slot and a plain i32 output", () => {
  const value = valueId(4);

  deepStrictEqual(opAccess({ kind: "var.read", variable: 2 }), {
    valueInputs: [],
    valueOutput: { type: "i32" },
    reads: [{ space: "var", variable: 2 }],
    writes: []
  });
  deepStrictEqual(opAccess({ kind: "var.write", variable: 2, value }), {
    valueInputs: [value],
    reads: [],
    writes: [{ space: "var", variable: 2 }]
  });
  strictEqual(opMutates({ kind: "var.write", variable: 2, value }), true);
});

test("memory.check observes memory bounds and produces a boolean predicate", () => {
  const address = valueId(5);
  const byteLength = valueId(6);

  deepStrictEqual(opAccess({ kind: "memory.check", address, byteLength, access: "read" }), {
    valueInputs: [address, byteLength],
    valueOutput: { type: "i32", bounds: fitsUnsigned(1) },
    reads: [memoryBounds],
    writes: []
  });
  strictEqual(opMutates({ kind: "memory.check", address, byteLength, access: "write" }), false);
});

test("memory.resolve is access-neutral and produces a boolean legacy resolution result", () => {
  const address = valueId(5);
  const byteLength = valueId(6);

  deepStrictEqual(opAccess({ kind: "memory.resolve", address, byteLength }), {
    valueInputs: [address, byteLength],
    valueOutput: { type: "i32", bounds: fitsUnsigned(1) },
    reads: [memoryBounds],
    writes: []
  });
  strictEqual(opMutates({ kind: "memory.resolve", address, byteLength }), false);
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
  const unsignedMemoryRead: IrOp = { kind: "memory.read", address: valueId(1), byteOffset: 0, width: 16 };
  const signedMemoryRead: IrOp = {
    kind: "memory.read",
    address: valueId(1),
    byteOffset: 0,
    width: 16,
    signed: true
  };

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
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: segmentLimitChannel("fs") }), { type: "i32" });
  deepStrictEqual(opValueOutput({ kind: "state.read", slot: segmentAccessChannel("fs") }), { type: "i32" });
  deepStrictEqual(opValueOutput({
    kind: "state.read",
    slot: { kind: "segmentDynamic", index: valueId(2), field: "limit" }
  }), { type: "i32" });
  deepStrictEqual(opValueOutput(unsignedMemoryRead), { type: "i32", bounds: fitsUnsigned(16) });
  deepStrictEqual(opValueOutput(signedMemoryRead), { type: "i32", bounds: signExtended(16) });
  deepStrictEqual(
    opValueOutput({ kind: "memory.read", address: valueId(1), byteOffset: 0, width: 32, signed: true }),
    { type: "i32" }
  );
  strictEqual(opValueOutput({ kind: "state.write", slot: gprChannel("eax"), value: valueId(1) }), undefined);
});
