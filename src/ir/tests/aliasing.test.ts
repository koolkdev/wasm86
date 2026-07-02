import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { actionMayWriteStateSlot, effectsOf, mayAlias, type StorageEffect } from "#ir/aliasing.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentBaseChannel,
  segmentSelectorChannel
} from "#ir/slots.js";
import type { StateSlot } from "#ir/slots.js";
import { memoryRead, memoryWrite, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

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
  deepStrictEqual(effectsOf(stateRead(0, gprChannel("eax"))), {
    reads: [state(gprChannel("eax"))],
    writes: []
  });
  deepStrictEqual(effectsOf(stateWrite(flagChannel("ZF"), 0)), {
    reads: [],
    writes: [state(flagChannel("ZF"))]
  });
  deepStrictEqual(effectsOf(stateWrite(dynamicGpr(3), 0)), {
    reads: [],
    writes: [state(dynamicGpr(3))]
  });
  deepStrictEqual(effectsOf(memoryRead(0, 1, 32)), {
    reads: [memory],
    writes: []
  });
  deepStrictEqual(effectsOf(memoryWrite(0, 1, 32)), {
    reads: [],
    writes: [memory]
  });
  deepStrictEqual(effectsOf({ kind: "op", output: 0, op: { kind: "cpu.resolveFlag", flag: "ZF" } }), {
    reads: [
      state(flagChannel("ZF")),
      state(lazyFlagsKindChannel),
      state(lazyFlagsAChannel),
      state(lazyFlagsBChannel)
    ],
    writes: []
  });
});

test("ifs and finishes touch no data directly", () => {
  deepStrictEqual(
    effectsOf({ kind: "if", condition: 0, thenBody: { actions: [] }, elseBody: { actions: [] } }),
    { reads: [], writes: [] }
  );
  deepStrictEqual(
    effectsOf({ kind: "finish", finish: { kind: "exit", reason: "unsupported" } }),
    { reads: [], writes: [] }
  );
  deepStrictEqual(
    effectsOf({ kind: "finish", finish: { kind: "dispatch", targetEip: 0 } }),
    { reads: [], writes: [] }
  );
});

test("if effects aggregate nested body effects", () => {
  const action = {
    kind: "if",
    condition: 0,
    thenBody: { actions: [stateRead(1, gprChannel("eax")), stateWrite(gprChannel("ebx"), 1)] },
    elseBody: { actions: [memoryWrite(2, 3, 32)] }
  } as const;

  deepStrictEqual(effectsOf(action), {
    reads: [state(gprChannel("eax"))],
    writes: [state(gprChannel("ebx")), memory]
  });
  strictEqual(actionMayWriteStateSlot(action, gprChannel("ebx")), true);
  strictEqual(actionMayWriteStateSlot(action, gprChannel("eax")), false);
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
    actionMayWriteStateSlot(stateWrite(gprChannel("eax"), 0), gprChannel("ax")),
    true
  );
  strictEqual(
    actionMayWriteStateSlot(stateWrite(flagChannel("ZF"), 0), flagChannel("ZF")),
    true
  );
  strictEqual(
    actionMayWriteStateSlot(stateWrite(flagChannel("ZF"), 0), flagChannel("CF")),
    false
  );
  strictEqual(
    actionMayWriteStateSlot(stateWrite(lazyFlagsKindChannel, 0), lazyFlagsKindChannel),
    true
  );
  strictEqual(
    actionMayWriteStateSlot(stateWrite(lazyFlagsKindChannel, 0), lazyFlagsAChannel),
    false
  );
  strictEqual(
    actionMayWriteStateSlot(
      stateWrite(segmentSelectorChannel("fs"), 0),
      segmentBaseChannel("fs")
    ),
    false
  );
  strictEqual(
    actionMayWriteStateSlot(stateWrite(flagChannel("ZF"), 0), gprChannel("eax")),
    false
  );
});
