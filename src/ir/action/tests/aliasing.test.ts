import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { effectsOf, mayAlias, type StorageEffect } from "#ir/action/aliasing.js";
import { eipChannel, flagChannel, gprChannel, type StateChannel } from "#ir/action/slots.js";

const memory: StorageEffect = { space: "memory" };

function state(channel: StateChannel): StorageEffect {
  return { space: "state", channel };
}

test("effects derive from action kind and slot", () => {
  deepStrictEqual(effectsOf({ kind: "readState", output: 0, slot: gprChannel("eax") }), {
    reads: state(gprChannel("eax"))
  });
  deepStrictEqual(effectsOf({ kind: "writeState", slot: flagChannel("ZF"), value: 0 }), {
    writes: state(flagChannel("ZF"))
  });
  deepStrictEqual(effectsOf({ kind: "readMemory", output: 0, address: 1, width: 32 }), {
    reads: memory
  });
  deepStrictEqual(effectsOf({ kind: "writeMemory", address: 0, value: 1, width: 32 }), {
    writes: memory
  });
});

test("guards, branches, and exits touch no data", () => {
  deepStrictEqual(
    effectsOf({ kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 }),
    {}
  );
  deepStrictEqual(effectsOf({ kind: "branch", condition: 0, taken: 1, notTaken: 2 }), {});
  deepStrictEqual(effectsOf({ kind: "exit", reason: "next" }), {});
});

test("guest memory may-aliases guest memory and never state", () => {
  strictEqual(mayAlias(memory, memory), true);
  strictEqual(mayAlias(memory, state(gprChannel("eax"))), false);
  strictEqual(mayAlias(state(eipChannel), memory), false);
});

test("static channels alias iff their byte ranges intersect", () => {
  strictEqual(mayAlias(state(gprChannel("eax")), state(gprChannel("ax"))), true);
  strictEqual(mayAlias(state(gprChannel("al")), state(gprChannel("ah"))), false);
  strictEqual(mayAlias(state(gprChannel("eax")), state(gprChannel("ebx"))), false);
  strictEqual(mayAlias(state(flagChannel("ZF")), state(flagChannel("ZF"))), true);
  strictEqual(mayAlias(state(flagChannel("ZF")), state(gprChannel("eax"))), false);
});
