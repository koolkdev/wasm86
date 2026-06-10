import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createPendingChannels, type PendingChannels } from "#ir/action/pending.js";
import { eipChannel, flagChannel, gprChannel } from "#ir/action/slots.js";
import type { Action } from "#ir/action/types.js";
import { createValueTable, type ValueTable } from "#ir/action/values.js";

type Harness = Readonly<{
  values: ValueTable;
  actions: Action[];
  pending: PendingChannels;
}>;

function createHarness(): Harness {
  const values = createValueTable();
  const actions: Action[] = [];

  return { values, actions, pending: createPendingChannels(values, (action) => actions.push(action)) };
}

test("an exact pending hit returns the value with no actions", () => {
  const { values, actions, pending } = createHarness();
  const value = values.internConst(0x12345678);

  pending.write(gprChannel("eax"), value);
  strictEqual(pending.read(gprChannel("eax")), value);
  deepStrictEqual(actions, []);
});

test("a read disjoint from all pendings loads through one cached readState", () => {
  const { values, actions, pending } = createHarness();

  pending.write(gprChannel("eax"), values.internConst(1));

  const first = pending.read(gprChannel("ebx"));

  strictEqual(pending.read(gprChannel("ebx")), first);
  deepStrictEqual(actions, [{ kind: "readState", output: first, slot: gprChannel("ebx") }]);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const { values, actions, pending } = createHarness();
  const byte = values.internConst(0x12);

  pending.write(gprChannel("al"), byte);

  const word = pending.read(gprChannel("eax"));

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("al"), value: byte },
    { kind: "readState", output: word, slot: gprChannel("eax") }
  ]);
  strictEqual(pending.has(gprChannel("al")), false);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x12345678);

  pending.write(gprChannel("eax"), word);

  // Deferred refinement: al could be served from the pending eax through a
  // projection; ah always goes through memory.
  const byte = pending.read(gprChannel("al"));

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: word },
    { kind: "readState", output: byte, slot: gprChannel("al") }
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const { values, actions, pending } = createHarness();

  pending.write(gprChannel("eax"), values.internConst(0x12345678));

  const high = pending.read(gprChannel("ah"));

  strictEqual(actions.length, 2);
  deepStrictEqual(actions[1], { kind: "readState", output: high, slot: gprChannel("ah") });
});

test("a covering write drops the pending with no flush", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x12345678);

  pending.write(gprChannel("al"), values.internConst(0x12));
  pending.write(gprChannel("ah"), values.internConst(0x34));
  pending.write(gprChannel("eax"), word);

  deepStrictEqual(actions, []);
  pending.flushAll();
  deepStrictEqual(actions, [{ kind: "writeState", slot: gprChannel("eax"), value: word }]);
});

test("a partially overlapping write flushes the wider pending first", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x12345678);
  const byte = values.internConst(0x9a);

  pending.write(gprChannel("ax"), word);
  pending.write(gprChannel("al"), byte);

  deepStrictEqual(actions, [{ kind: "writeState", slot: gprChannel("ax"), value: word }]);
  pending.flushAll();
  deepStrictEqual(actions[1], { kind: "writeState", slot: gprChannel("al"), value: byte });
});

test("disjoint byte pendings coexist and flush together on an ax read", () => {
  const { values, actions, pending } = createHarness();
  const low = values.internConst(0x12);
  const high = values.internConst(0x34);
  const flag = values.internConst(1);

  pending.write(flagChannel("ZF"), flag);
  pending.write(gprChannel("al"), low);
  pending.write(gprChannel("ah"), high);
  deepStrictEqual(actions, []);

  const word = pending.read(gprChannel("ax"));

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("al"), value: low },
    { kind: "writeState", slot: gprChannel("ah"), value: high },
    { kind: "readState", output: word, slot: gprChannel("ax") }
  ]);

  // Flag pendings are untouched by register traffic.
  strictEqual(pending.has(flagChannel("ZF")), true);
  strictEqual(pending.read(flagChannel("ZF")), flag);
});

test("flag and eip pendings hit exactly and never interact with registers", () => {
  const { values, actions, pending } = createHarness();
  const eip = values.internConst(0x401000);

  pending.write(eipChannel, eip);
  pending.write(gprChannel("eax"), values.internConst(7));
  strictEqual(pending.read(eipChannel), eip);
  deepStrictEqual(actions, []);
});

test("a flush invalidates read leaves of overlapping channels only", () => {
  const { values, actions, pending } = createHarness();
  const eaxRead = pending.read(gprChannel("eax"));
  const ecxRead = pending.read(gprChannel("ecx"));

  pending.write(gprChannel("al"), values.internConst(0x12));

  // The al flush makes the cached eax leaf stale; ecx is unaffected.
  const reloaded = pending.read(gprChannel("eax"));

  notStrictEqual(reloaded, eaxRead);
  strictEqual(pending.read(gprChannel("ecx")), ecxRead);
  strictEqual(actions.filter((action) => action.kind === "readState").length, 3);
});

test("signed and unsigned reads of one channel are separate marked loads", () => {
  const { actions, pending } = createHarness();
  const unsigned = pending.read(gprChannel("al"));
  const signed = pending.read(gprChannel("al"), { signed: true });

  notStrictEqual(signed, unsigned);
  strictEqual(pending.read(gprChannel("al")), unsigned);
  strictEqual(pending.read(gprChannel("al"), { signed: true }), signed);
  deepStrictEqual(actions, [
    { kind: "readState", output: unsigned, slot: gprChannel("al") },
    { kind: "readState", output: signed, slot: gprChannel("al"), signed: true }
  ]);
});

test("a signed read of a full-width channel is the plain read", () => {
  const { actions, pending } = createHarness();
  const read = pending.read(gprChannel("eax"), { signed: true });

  strictEqual(pending.read(gprChannel("eax")), read);
  deepStrictEqual(actions, [{ kind: "readState", output: read, slot: gprChannel("eax") }]);
});

test("an exact narrow hit normalizes values whose high bits are unproven", () => {
  const { values, pending } = createHarness();
  const unproven = values.addActionOutput();

  pending.write(gprChannel("al"), unproven);
  strictEqual(pending.read(gprChannel("al")), values.internProject(8, unproven));
  strictEqual(
    pending.read(gprChannel("al"), { signed: true }),
    values.internUnary("extend8_s", unproven)
  );

  // A value that provably fits the channel passes through untouched.
  const byte = values.internConst(0x12);

  pending.write(gprChannel("ah"), byte);
  strictEqual(pending.read(gprChannel("ah")), byte);
});

test("flushAll materializes every pending in insertion order", () => {
  const { values, actions, pending } = createHarness();
  const flag = values.internConst(1);
  const word = values.internConst(7);

  pending.write(flagChannel("CF"), flag);
  pending.write(gprChannel("esi"), word);
  pending.flushAll();

  deepStrictEqual(actions, [
    { kind: "writeState", slot: flagChannel("CF"), value: flag },
    { kind: "writeState", slot: gprChannel("esi"), value: word }
  ]);
  strictEqual(pending.has(flagChannel("CF")), false);
  strictEqual(pending.has(gprChannel("esi")), false);
});
