import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { actionMayWriteStateSlot, effectsOf, mayAlias, type StorageEffect } from "#ir/aliasing.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  lazyFlagsAChannel,
  lazyFlagsKindChannel,
  segmentBaseChannel,
  segmentSelectorChannel
} from "#ir/slots.js";
import type { StateSlot } from "#ir/slots.js";

const memory: StorageEffect = { space: "memory" };

function state(slot: StateSlot): StorageEffect {
  return { space: "state", slot };
}

function dynamicGpr(index: number, byteLength: 1 | 2 | 4 = 4): StateSlot {
  return { kind: "gprDynamic", index, byteLength };
}

function dynamicSegmentBase(index: number): StateSlot {
  return { kind: "segmentDynamic", index, field: "base" };
}

function dynamicSegmentSelector(index: number): StateSlot {
  return { kind: "segmentDynamic", index, field: "selector" };
}

test("effects derive from action kind and slot", () => {
  deepStrictEqual(effectsOf({ kind: "readState", output: 0, slot: gprChannel("eax") }), {
    reads: state(gprChannel("eax"))
  });
  deepStrictEqual(effectsOf({ kind: "writeState", slot: flagChannel("ZF"), value: 0 }), {
    writes: state(flagChannel("ZF"))
  });
  deepStrictEqual(effectsOf({ kind: "writeState", slot: dynamicGpr(3), value: 0 }), {
    writes: state(dynamicGpr(3))
  });
  deepStrictEqual(effectsOf({ kind: "readMemory", output: 0, address: 1, width: 32 }), {
    reads: memory
  });
  deepStrictEqual(effectsOf({ kind: "writeMemory", address: 0, value: 1, width: 32 }), {
    writes: memory
  });
});

test("guards, branches, exits, and dispatches touch no data", () => {
  deepStrictEqual(
    effectsOf({ kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 }),
    {}
  );
  deepStrictEqual(effectsOf({ kind: "branch", condition: 0, taken: 1, notTaken: 2 }), {});
  deepStrictEqual(effectsOf({ kind: "exit", reason: "unsupported" }), {});
  deepStrictEqual(effectsOf({ kind: "dispatch", targetEip: 0 }), {});
});

test("guest memory may-aliases guest memory and never state", () => {
  strictEqual(mayAlias(memory, memory), true);
  strictEqual(mayAlias(memory, state(gprChannel("eax"))), false);
  strictEqual(mayAlias(state(eipChannel), memory), false);
  strictEqual(mayAlias(state(dynamicGpr(0)), memory), false);
});

test("static channels alias iff their byte ranges intersect", () => {
  strictEqual(mayAlias(state(gprChannel("eax")), state(gprChannel("ax"))), true);
  strictEqual(mayAlias(state(gprChannel("al")), state(gprChannel("ah"))), false);
  strictEqual(mayAlias(state(gprChannel("eax")), state(gprChannel("ebx"))), false);
  strictEqual(mayAlias(state(flagChannel("ZF")), state(flagChannel("ZF"))), true);
  strictEqual(mayAlias(state(flagChannel("ZF")), state(gprChannel("eax"))), false);
  strictEqual(mayAlias(state(lazyFlagsKindChannel), state(lazyFlagsKindChannel)), true);
  strictEqual(mayAlias(state(lazyFlagsKindChannel), state(lazyFlagsAChannel)), false);
  strictEqual(mayAlias(state(lazyFlagsKindChannel), state(flagChannel("ZF"))), false);
  strictEqual(mayAlias(state(segmentSelectorChannel("fs")), state(segmentSelectorChannel("fs"))), true);
  strictEqual(mayAlias(state(segmentSelectorChannel("fs")), state(segmentBaseChannel("fs"))), false);
  strictEqual(mayAlias(state(segmentBaseChannel("fs")), state(segmentBaseChannel("gs"))), false);
});

test("a dynamic GPR slot may-aliases every GPR word and never exact cells", () => {
  strictEqual(mayAlias(state(dynamicGpr(0)), state(gprChannel("eax"))), true);
  strictEqual(mayAlias(state(gprChannel("bl")), state(dynamicGpr(0))), true);
  strictEqual(mayAlias(state(dynamicGpr(0)), state(dynamicGpr(1))), true);
  strictEqual(mayAlias(state(dynamicGpr(0, 1)), state(gprChannel("esi"))), true);
  strictEqual(mayAlias(state(dynamicGpr(0)), state(flagChannel("ZF"))), false);
  strictEqual(mayAlias(state(flagChannel("CF")), state(dynamicGpr(0))), false);
  strictEqual(mayAlias(state(dynamicGpr(0)), state(lazyFlagsKindChannel)), false);
  strictEqual(mayAlias(state(lazyFlagsKindChannel), state(dynamicGpr(0))), false);
  strictEqual(mayAlias(state(dynamicGpr(0)), state(eipChannel)), false);
  strictEqual(mayAlias(state(eipChannel), state(dynamicGpr(0))), false);
  strictEqual(mayAlias(state(dynamicGpr(0)), state(segmentSelectorChannel("fs"))), false);
  strictEqual(mayAlias(state(segmentBaseChannel("fs")), state(dynamicGpr(0))), false);
});

test("a dynamic segment slot may-aliases segment channels for the same field", () => {
  strictEqual(mayAlias(state(dynamicSegmentBase(0)), state(segmentBaseChannel("fs"))), true);
  strictEqual(mayAlias(state(segmentBaseChannel("gs")), state(dynamicSegmentBase(0))), true);
  strictEqual(mayAlias(state(dynamicSegmentBase(0)), state(dynamicSegmentBase(1))), true);
  strictEqual(mayAlias(state(dynamicSegmentSelector(0)), state(segmentSelectorChannel("fs"))), true);
  strictEqual(mayAlias(state(segmentSelectorChannel("gs")), state(dynamicSegmentSelector(0))), true);
  strictEqual(mayAlias(state(dynamicSegmentSelector(0)), state(dynamicSegmentSelector(1))), true);
  strictEqual(mayAlias(state(dynamicSegmentBase(0)), state(segmentSelectorChannel("fs"))), false);
  strictEqual(mayAlias(state(segmentSelectorChannel("fs")), state(dynamicSegmentBase(0))), false);
  strictEqual(mayAlias(state(dynamicSegmentSelector(0)), state(segmentBaseChannel("fs"))), false);
  strictEqual(mayAlias(state(segmentBaseChannel("fs")), state(dynamicSegmentSelector(0))), false);
  strictEqual(mayAlias(state(dynamicSegmentSelector(0)), state(dynamicSegmentBase(0))), false);
  strictEqual(mayAlias(state(dynamicSegmentBase(0)), state(gprChannel("eax"))), false);
  strictEqual(mayAlias(state(gprChannel("eax")), state(dynamicSegmentBase(0))), false);
});

test("action writes include raw state slots", () => {
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: gprChannel("eax"), value: 0 }, gprChannel("ax")),
    true
  );
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: flagChannel("ZF"), value: 0 }, flagChannel("ZF")),
    true
  );
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: flagChannel("ZF"), value: 0 }, flagChannel("CF")),
    false
  );
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: lazyFlagsKindChannel, value: 0 }, lazyFlagsKindChannel),
    true
  );
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: lazyFlagsKindChannel, value: 0 }, lazyFlagsAChannel),
    false
  );
  strictEqual(
    actionMayWriteStateSlot(
      { kind: "writeState", slot: segmentSelectorChannel("fs"), value: 0 },
      segmentBaseChannel("fs")
    ),
    false
  );
  strictEqual(
    actionMayWriteStateSlot({ kind: "writeState", slot: flagChannel("ZF"), value: 0 }, gprChannel("eax")),
    false
  );
});
