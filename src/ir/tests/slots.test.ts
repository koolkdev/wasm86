import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  channelCovers,
  channelsOverlap,
  eipChannel,
  flagChannel,
  gprChannel,
  type StateChannel
} from "#ir/slots.js";
import { x86Flags } from "#x86/flags.js";
import { reg16, reg32, reg8 } from "#x86/types.js";

test("gpr channels describe byte ranges within their register", () => {
  deepStrictEqual(gprChannel("eax"), { kind: "gpr", reg: "eax", byteOffsetInReg: 0, byteLength: 4 });
  deepStrictEqual(gprChannel("ax"), { kind: "gpr", reg: "eax", byteOffsetInReg: 0, byteLength: 2 });
  deepStrictEqual(gprChannel("al"), { kind: "gpr", reg: "eax", byteOffsetInReg: 0, byteLength: 1 });
  deepStrictEqual(gprChannel("ah"), { kind: "gpr", reg: "eax", byteOffsetInReg: 1, byteLength: 1 });
  deepStrictEqual(gprChannel("di"), { kind: "gpr", reg: "edi", byteOffsetInReg: 0, byteLength: 2 });
  deepStrictEqual(gprChannel("bh"), { kind: "gpr", reg: "ebx", byteOffsetInReg: 1, byteLength: 1 });

  for (const name of [...reg32, ...reg16, ...reg8]) {
    strictEqual(gprChannel(name), gprChannel(name));
  }

  throws(() => gprChannel("xx" as never), /unknown register channel/);
});

test("flag and eip channels are atomic units", () => {
  for (const flag of x86Flags) {
    deepStrictEqual(flagChannel(flag), { kind: "flag", flag });
    strictEqual(flagChannel(flag), flagChannel(flag));
  }

  deepStrictEqual(eipChannel, { kind: "eip" });
  throws(() => flagChannel("DF" as never), /unknown flag channel/);
});

test("channelsOverlap matches byte-range intersection for gpr channels", () => {
  const overlapCases: ReadonlyArray<readonly [StateChannel, StateChannel, boolean]> = [
    [gprChannel("eax"), gprChannel("eax"), true],
    [gprChannel("eax"), gprChannel("ax"), true],
    [gprChannel("eax"), gprChannel("al"), true],
    [gprChannel("eax"), gprChannel("ah"), true],
    [gprChannel("ax"), gprChannel("al"), true],
    [gprChannel("ax"), gprChannel("ah"), true],
    [gprChannel("al"), gprChannel("al"), true],
    [gprChannel("al"), gprChannel("ah"), false],
    [gprChannel("eax"), gprChannel("ecx"), false],
    [gprChannel("al"), gprChannel("cl"), false],
    [gprChannel("ah"), gprChannel("ch"), false],
    [gprChannel("ax"), gprChannel("cx"), false],
    [gprChannel("esi"), gprChannel("si"), true]
  ];

  for (const [a, b, expected] of overlapCases) {
    strictEqual(channelsOverlap(a, b), expected, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    strictEqual(channelsOverlap(b, a), expected, `${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
  }
});

test("channelCovers requires full byte-range containment", () => {
  const coverCases: ReadonlyArray<readonly [StateChannel, StateChannel, boolean]> = [
    [gprChannel("eax"), gprChannel("eax"), true],
    [gprChannel("eax"), gprChannel("ax"), true],
    [gprChannel("eax"), gprChannel("al"), true],
    [gprChannel("eax"), gprChannel("ah"), true],
    [gprChannel("ax"), gprChannel("al"), true],
    [gprChannel("ax"), gprChannel("ah"), true],
    [gprChannel("ax"), gprChannel("eax"), false],
    [gprChannel("al"), gprChannel("ax"), false],
    [gprChannel("al"), gprChannel("ah"), false],
    [gprChannel("ah"), gprChannel("ax"), false],
    [gprChannel("eax"), gprChannel("cl"), false]
  ];

  for (const [outer, inner, expected] of coverCases) {
    strictEqual(channelCovers(outer, inner), expected, `${JSON.stringify(outer)} covers ${JSON.stringify(inner)}`);
  }

  strictEqual(channelCovers(flagChannel("CF"), flagChannel("CF")), true);
  strictEqual(channelCovers(flagChannel("CF"), flagChannel("ZF")), false);
  strictEqual(channelCovers(eipChannel, eipChannel), true);
  strictEqual(channelCovers(eipChannel, gprChannel("eax")), false);
});

test("channelsOverlap keeps flags and eip disjoint from everything else", () => {
  strictEqual(channelsOverlap(flagChannel("CF"), flagChannel("CF")), true);
  strictEqual(channelsOverlap(flagChannel("CF"), flagChannel("ZF")), false);
  strictEqual(channelsOverlap(eipChannel, eipChannel), true);

  for (const other of [gprChannel("eax"), gprChannel("ah"), flagChannel("OF")]) {
    strictEqual(channelsOverlap(eipChannel, other), false);
    strictEqual(channelsOverlap(other, eipChannel), false);
  }

  strictEqual(channelsOverlap(flagChannel("CF"), gprChannel("eax")), false);
  strictEqual(channelsOverlap(gprChannel("eax"), flagChannel("CF")), false);
});
