import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  channelCovers,
  channelsOverlap,
  eipChannel,
  flagChannel,
  gprChannel,
  instructionCountChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentBaseChannel,
  segmentSelectorChannel,
  type StateChannel
} from "#ir/slots.js";
import { x86Flags } from "#x86/flags.js";
import { reg16, reg32, reg8, segmentRegisters } from "#x86/types.js";

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
  deepStrictEqual(instructionCountChannel, { kind: "instructionCount" });
});

test("lazy flag metadata channels are raw state fields", () => {
  deepStrictEqual(lazyFlagsKindChannel, { kind: "lazyFlags", field: "lazyFlagsKind" });
  deepStrictEqual(lazyFlagsAChannel, { kind: "lazyFlags", field: "lazyFlagsA" });
  deepStrictEqual(lazyFlagsBChannel, { kind: "lazyFlags", field: "lazyFlagsB" });
});

test("segment channels split visible selectors from hidden bases", () => {
  for (const reg of segmentRegisters) {
    deepStrictEqual(segmentSelectorChannel(reg), { kind: "segment", reg, field: "selector" });
    deepStrictEqual(segmentBaseChannel(reg), { kind: "segment", reg, field: "base" });
    strictEqual(segmentSelectorChannel(reg), segmentSelectorChannel(reg));
    strictEqual(segmentBaseChannel(reg), segmentBaseChannel(reg));
  }
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
  strictEqual(channelCovers(lazyFlagsKindChannel, lazyFlagsKindChannel), true);
  strictEqual(channelCovers(lazyFlagsKindChannel, lazyFlagsAChannel), false);
  strictEqual(channelCovers(lazyFlagsAChannel, lazyFlagsKindChannel), false);
  strictEqual(channelCovers(segmentSelectorChannel("fs"), segmentSelectorChannel("fs")), true);
  strictEqual(channelCovers(segmentBaseChannel("fs"), segmentBaseChannel("fs")), true);
  strictEqual(channelCovers(segmentSelectorChannel("fs"), segmentBaseChannel("fs")), false);
  strictEqual(channelCovers(segmentBaseChannel("fs"), segmentSelectorChannel("fs")), false);
});

test("channelsOverlap keeps exact cells disjoint from everything else", () => {
  strictEqual(channelsOverlap(flagChannel("CF"), flagChannel("CF")), true);
  strictEqual(channelsOverlap(flagChannel("CF"), flagChannel("ZF")), false);
  strictEqual(channelsOverlap(eipChannel, eipChannel), true);
  strictEqual(channelsOverlap(lazyFlagsKindChannel, lazyFlagsKindChannel), true);
  strictEqual(channelsOverlap(lazyFlagsKindChannel, lazyFlagsAChannel), false);
  strictEqual(channelsOverlap(lazyFlagsAChannel, lazyFlagsKindChannel), false);
  strictEqual(channelsOverlap(segmentSelectorChannel("fs"), segmentSelectorChannel("fs")), true);
  strictEqual(channelsOverlap(segmentSelectorChannel("fs"), segmentBaseChannel("fs")), false);
  strictEqual(channelsOverlap(segmentBaseChannel("fs"), segmentBaseChannel("gs")), false);

  for (const other of [gprChannel("eax"), gprChannel("ah"), flagChannel("OF"), lazyFlagsKindChannel, segmentBaseChannel("fs")]) {
    strictEqual(channelsOverlap(eipChannel, other), false);
    strictEqual(channelsOverlap(other, eipChannel), false);
  }

  strictEqual(channelsOverlap(flagChannel("CF"), gprChannel("eax")), false);
  strictEqual(channelsOverlap(gprChannel("eax"), flagChannel("CF")), false);
  strictEqual(channelsOverlap(lazyFlagsAChannel, gprChannel("eax")), false);
  strictEqual(channelsOverlap(gprChannel("eax"), lazyFlagsBChannel), false);
  strictEqual(channelsOverlap(lazyFlagsKindChannel, flagChannel("CF")), false);
  strictEqual(channelsOverlap(flagChannel("CF"), lazyFlagsKindChannel), false);
});
