import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { flagChannel, gprChannel } from "#ir/action/slots.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";

test("host view splits eflags into flag bytes and ctrl word and merges them back", () => {
  const { state } = createWasmHostMemories();
  const eflags = 0xffff_08d5;

  state.load({ eflags });

  deepStrictEqual(
    x86ArithmeticFlags.map((flag) => [flag, state.readFlagByte(flag)]),
    [["CF", 1], ["PF", 1], ["AF", 1], ["ZF", 1], ["SF", 1], ["OF", 1]]
  );
  strictEqual(state.snapshot().eflags, eflags);

  state.load({ eflags: 0x0000_0202 });

  strictEqual(state.snapshot().eflags, 0x0000_0202);
  deepStrictEqual(
    x86ArithmeticFlags.map((flag) => state.readFlagByte(flag)),
    [0, 0, 0, 0, 0, 0]
  );
});

test("flag byte writes are visible to snapshots", () => {
  const { state } = createWasmHostMemories();

  state.load({ eflags: 0x0000_0002 });
  state.writeFlagByte("CF", 1);
  state.writeFlagByte("ZF", 0xff);

  strictEqual(state.readFlagByte("CF"), 1);
  strictEqual(state.readFlagByte("ZF"), 1);
  strictEqual(state.snapshot().eflags, 0x0000_0043);

  state.writeChannel(flagChannel("CF"), 0);

  strictEqual(state.readChannel(flagChannel("CF")), 0);
  strictEqual(state.snapshot().eflags, 0x0000_0042);
});

test("eflags setter writes the flag bytes and the ctrl word", () => {
  const { state } = createWasmHostMemories();

  state.eflags = 0x0000_00c7;

  strictEqual(state.snapshot().eflags, 0x0000_00c7);
  strictEqual(state.readFlagByte("CF"), 1);
  strictEqual(state.readFlagByte("AF"), 0);
});

test("gpr channels read and write at every width against the state word", () => {
  const { state } = createWasmHostMemories();

  state.load({ eax: 0xaabb_ccdd, ecx: 0x1122_3344, esi: 0x5566_7788 });

  strictEqual(state.readChannel(gprChannel("eax")), 0xaabb_ccdd);
  strictEqual(state.readChannel(gprChannel("ax")), 0xccdd);
  strictEqual(state.readChannel(gprChannel("al")), 0xdd);
  strictEqual(state.readChannel(gprChannel("ah")), 0xcc);
  strictEqual(state.readChannel(gprChannel("si")), 0x7788);

  state.writeChannel(gprChannel("ah"), 0x11);

  strictEqual(state.read("eax"), 0xaabb_11dd);

  state.writeChannel(gprChannel("al"), 0x22);

  strictEqual(state.read("eax"), 0xaabb_1122);

  state.writeChannel(gprChannel("ax"), 0x3344);

  strictEqual(state.read("eax"), 0xaabb_3344);

  state.writeChannel(gprChannel("eax"), 0xdead_beef);

  strictEqual(state.read("eax"), 0xdead_beef);
  strictEqual(state.read("ecx"), 0x1122_3344);

  state.writeChannel(gprChannel("cl"), 0x99);

  strictEqual(state.read("ecx"), 0x1122_3399);
  strictEqual(state.read("esi"), 0x5566_7788);
});

test("narrow channel writes truncate the value and leave neighbor bytes untouched", () => {
  const { state } = createWasmHostMemories();

  state.load({ eax: 0xdead_beef });

  state.writeChannel(gprChannel("al"), 0x1ff);

  strictEqual(state.read("eax"), 0xdead_beff);

  state.writeChannel(gprChannel("ah"), 0x301);

  strictEqual(state.read("eax"), 0xdead_01ff);

  state.writeChannel(gprChannel("ax"), 0x5_4321);

  strictEqual(state.read("eax"), 0xdead_4321);
});
