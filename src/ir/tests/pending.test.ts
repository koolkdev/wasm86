import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createPendingChannels, type PendingChannels } from "#ir/pending.js";
import { eipChannel, flagChannel, gprChannel } from "#ir/slots.js";
import type { Action, GprDynamicSlot } from "#ir/actions.js";
import { createValueTable, type ValueId, type ValueTable } from "#ir/values.js";

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

function dynamicGpr(index: ValueId, byteLength: 1 | 2 | 4 = 4): GprDynamicSlot {
  return { kind: "gprDynamic", index, byteLength };
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

  // The flushed al stays pending, clean: it serves reads with no new
  // actions and never needs storing again.
  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.read(gprChannel("al")), byte);
  pending.flushAll();
  strictEqual(actions.length, 2);
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

test("flushAll materializes every dirty pending in insertion order", () => {
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

  // Everything is clean now: reads still hit, nothing stores twice.
  strictEqual(pending.read(flagChannel("CF")), flag);
  strictEqual(pending.read(gprChannel("esi")), word);
  pending.flushAll();
  strictEqual(actions.length, 2);
});

test("snapshot lists instruction-start values without consuming the map", () => {
  const { values, actions, pending } = createHarness();
  const byte = values.internConst(0x12);
  const eip = values.internConst(0x1000);

  pending.write(gprChannel("al"), byte);
  pending.write(eipChannel, eip);
  pending.beginInstruction();

  deepStrictEqual(pending.snapshot(), [
    [gprChannel("al"), byte],
    [eipChannel, eip]
  ]);
  deepStrictEqual(actions, []);
  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.has(eipChannel), true);
});

test("snapshot keeps a rewritten channel's instruction-start value", () => {
  const { values, pending } = createHarness();
  const before = values.internConst(1);
  const after = values.internConst(2);

  pending.write(gprChannel("eax"), before);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), after);

  deepStrictEqual(pending.snapshot(), [[gprChannel("eax"), before]]);
  strictEqual(pending.read(gprChannel("eax")), after);
});

test("snapshot omits a channel first written this instruction", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.internConst(1));

  deepStrictEqual(pending.snapshot(), []);
});

test("a covering write keeps the dropped channel's start value in the snapshot", () => {
  const { values, pending } = createHarness();
  const byte = values.internConst(0x12);

  pending.write(gprChannel("al"), byte);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.internConst(0x12345678));

  // eax had no start pending (omitted); the dropped al still must reach
  // cpu state memory on the fault path.
  deepStrictEqual(pending.snapshot(), [[gprChannel("al"), byte]]);
});

test("flushing a channel first written this instruction makes the snapshot unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("al"), values.internConst(1));
  pending.read(gprChannel("ax"));

  throws(() => pending.snapshot(), /unrestorable/);

  // The next instruction boundary takes a fresh copy; the flushed al is
  // clean but still pending, so it joins the new boundary.
  pending.beginInstruction();
  deepStrictEqual(pending.snapshot(), [[gprChannel("al"), values.internConst(1)]]);
});

test("flushing a channel rewritten this instruction keeps its start value in the snapshot", () => {
  const { values, pending } = createHarness();
  const before = values.internConst(0x111);

  pending.write(gprChannel("eax"), before);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.internConst(0x222));
  pending.read(gprChannel("al"));

  deepStrictEqual(pending.snapshot(), [[gprChannel("eax"), before]]);
});

test("flushing a channel untouched this instruction keeps it in the snapshot", () => {
  const { values, pending } = createHarness();
  const byte = values.internConst(0x12);

  pending.write(gprChannel("al"), byte);
  pending.beginInstruction();
  pending.read(gprChannel("ax"));

  // The flush already stored this value; rewriting it is harmless.
  deepStrictEqual(pending.snapshot(), [[gprChannel("al"), byte]]);
});

test("a covering write drops a clean pending without a store", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x12345678);

  pending.write(gprChannel("al"), values.internConst(0x12));
  pending.read(gprChannel("eax"));
  pending.write(gprChannel("eax"), word);
  pending.flushAll();

  // One al store (the flush before the read); the covering eax write drops
  // the clean al, so only eax flushes at the end.
  strictEqual(actions[0]!.kind, "writeState");
  deepStrictEqual(actions[2], { kind: "writeState", slot: gprChannel("eax"), value: word });
  strictEqual(actions.length, 3);
});

test("entries lists only dirty pendings", () => {
  const { values, pending } = createHarness();
  const byte = values.internConst(0x12);
  const flag = values.internConst(1);

  pending.write(gprChannel("al"), byte);
  pending.write(flagChannel("ZF"), flag);
  pending.read(gprChannel("ax"));

  // The ax read flushed al; only the flag is still dirty.
  deepStrictEqual(pending.entries(), [[flagChannel("ZF"), flag]]);
});

test("a dynamic read flushes dirty GPR pendings and leaves them clean", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x77);
  const flag = values.internConst(1);
  const index = values.internExternal(0);

  pending.write(gprChannel("eax"), word);
  pending.write(flagChannel("ZF"), flag);

  const first = pending.readDynamicGpr(dynamicGpr(index));

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: word },
    { kind: "readState", output: first, slot: dynamicGpr(index) }
  ]);

  // eax is clean: it still serves reads and the next dynamic read flushes
  // nothing. Each dynamic read loads fresh — the channel is unknown.
  strictEqual(pending.read(gprChannel("eax")), word);

  const second = pending.readDynamicGpr(dynamicGpr(index));

  notStrictEqual(second, first);
  deepStrictEqual(actions[2], { kind: "readState", output: second, slot: dynamicGpr(index) });
  strictEqual(actions.length, 3);
  strictEqual(pending.read(flagChannel("ZF")), flag);
});

test("a dynamic write stores immediately and invalidates every GPR pending", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x77);
  const flag = values.internConst(1);
  const eip = values.internConst(0x1000);
  const stored = values.internConst(0x222);
  const index = values.internExternal(0);

  pending.write(gprChannel("eax"), word);
  pending.write(flagChannel("CF"), flag);
  pending.write(eipChannel, eip);
  pending.writeDynamicGpr(dynamicGpr(index), stored);

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: word },
    { kind: "writeState", slot: dynamicGpr(index), value: stored }
  ]);

  // The just-cleaned eax is gone too — the store may have hit its word —
  // while flag and eip pendings ride through.
  const reload = pending.read(gprChannel("eax"));

  deepStrictEqual(actions[2], { kind: "readState", output: reload, slot: gprChannel("eax") });
  strictEqual(pending.read(flagChannel("CF")), flag);
  strictEqual(pending.read(eipChannel), eip);
});

test("a dynamic write invalidates cached GPR read leaves but not flag leaves", () => {
  const { values, pending } = createHarness();
  const index = values.internExternal(0);
  const eaxRead = pending.read(gprChannel("eax"));
  const zfRead = pending.read(flagChannel("ZF"));

  pending.writeDynamicGpr(dynamicGpr(index), values.internConst(1));

  notStrictEqual(pending.read(gprChannel("eax")), eaxRead);
  strictEqual(pending.read(flagChannel("ZF")), zfRead);
});

test("a dynamic write makes the boundary snapshot unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.writeDynamicGpr(dynamicGpr(values.internExternal(0)), values.internConst(1));

  throws(() => pending.snapshot(), /unrestorable/);

  // The next instruction boundary takes a fresh copy.
  pending.beginInstruction();
  deepStrictEqual(pending.snapshot(), []);
});

test("a dynamic read flushing a channel first written this instruction is unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("ebx"), values.internConst(0x111));
  pending.readDynamicGpr(dynamicGpr(values.internExternal(0)));

  throws(() => pending.snapshot(), /unrestorable/);
});

test("a dynamic read flushing a boundary pending keeps the snapshot restorable", () => {
  const { values, pending } = createHarness();
  const before = values.internConst(0x111);

  pending.write(gprChannel("ebx"), before);
  pending.beginInstruction();
  pending.readDynamicGpr(dynamicGpr(values.internExternal(0)));

  deepStrictEqual(pending.snapshot(), [[gprChannel("ebx"), before]]);
});

test("a destructive flush served by a cached read keeps the snapshot restorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();

  const before = pending.read(gprChannel("esp"));

  pending.write(gprChannel("esp"), values.internConst(0x44));
  pending.readDynamicGpr(dynamicGpr(values.internExternal(0)));

  // The cached read is the pre-instruction value — no store hit esp before
  // its first flush — so it joins the boundary instead of latching the
  // unrestorable assert.
  deepStrictEqual(pending.snapshot(), [[gprChannel("esp"), before]]);
});

test("a signed cached read serves a destructive flush of its channel", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();

  const before = pending.read(gprChannel("al"), { signed: true });

  pending.write(gprChannel("al"), values.internConst(0x12));
  pending.read(gprChannel("ax"));

  // The sign-extended read's low channel-width bits are the memory bytes;
  // the channel-width boundary store masks the rest.
  deepStrictEqual(pending.snapshot(), [[gprChannel("al"), before]]);
});

test("narrow dynamic reads carry their byte length, bounds, and sign marker", () => {
  const { values, actions, pending } = createHarness();
  const index = values.internExternal(0);
  const unsigned = pending.readDynamicGpr(dynamicGpr(index, 1));
  const signed = pending.readDynamicGpr(dynamicGpr(index, 1), { signed: true });

  deepStrictEqual(actions, [
    { kind: "readState", output: unsigned, slot: dynamicGpr(index, 1) },
    { kind: "readState", output: signed, slot: dynamicGpr(index, 1), signed: true }
  ]);

  // Bounds match static narrow channels: no masks or extends downstream.
  strictEqual(values.projectTo(8, unsigned), unsigned);
  strictEqual(values.extendTo(8, signed), signed);
});

test("a signed dynamic word read is the plain read", () => {
  const { values, actions, pending } = createHarness();
  const index = values.internExternal(0);
  const read = pending.readDynamicGpr(dynamicGpr(index), { signed: true });

  deepStrictEqual(actions, [{ kind: "readState", output: read, slot: dynamicGpr(index) }]);
});

test("a narrow dynamic write barriers word pendings all the same", () => {
  const { values, actions, pending } = createHarness();
  const word = values.internConst(0x12345678);
  const byte = values.internConst(0x9a);
  const index = values.internExternal(0);

  pending.write(gprChannel("eax"), word);
  pending.writeDynamicGpr(dynamicGpr(index, 1), byte);

  deepStrictEqual(actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: word },
    { kind: "writeState", slot: dynamicGpr(index, 1), value: byte }
  ]);

  const reload = pending.read(gprChannel("eax"));

  deepStrictEqual(actions[2], { kind: "readState", output: reload, slot: gprChannel("eax") });
});
