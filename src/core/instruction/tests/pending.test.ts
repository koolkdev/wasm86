import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { RegionBuilder } from "#ir/region-builder.js";
import { StateFieldTracker } from "../state/field-tracker.js";
import type { StatePathKind } from "../state/pending-buffer.js";
import { GprState, type GprReadOptions } from "../state/gpr.js";
import { SegmentState } from "../state/segments.js";
import { StateAccess } from "#core/state/access.js";
import { cpuState } from "#test/support/execution-model.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "../state/channels.js";
import {
  gprChannel,
  segmentBaseChannel,
  segmentSelectorChannel
} from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { BodyNode } from "#ir/block.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { OperandWidth } from "#core/types.js";
import {
  dynamicGprRead,
  dynamicGprWrite,
  dynamicSegmentRead,
  stateEffect,
  stateRead,
  stateWrite,
  stateWriteValue,
  isStateRead,
  isStateWrite,
  type StateWriteOperation
} from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  nodes: BodyNode[];
  pending: PendingHarness;
}>;

type PendingHarness = Readonly<{
  read(channel: InstructionStateChannel, options?: GprReadOptions): ValueId;
  write(channel: InstructionStateChannel, value: ValueId): void;
  has(channel: InstructionStateChannel): boolean;
  beginInstruction(): void;
  flushesForPath(path: StatePathKind): readonly StateWriteOperation[];
  readDynamicGpr(index: ValueId, width: OperandWidth, options?: GprReadOptions): ValueId;
  writeDynamicGpr(index: ValueId, width: OperandWidth, value: ValueId): void;
  readDynamicSegmentBase(index: ValueId): ValueId;
  readDynamicSegmentSelector(index: ValueId): ValueId;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const nodes = body.build().nodes as BodyNode[];
  const accessConstruction = new StateAccess(cpuState);
  const access = accessConstruction.bind(body);
  const fields = new StateFieldTracker(accessConstruction);
  const gpr = new GprState(accessConstruction);
  const flushesForPath = (path: StatePathKind): readonly StateWriteOperation[] => [
    ...gpr.flushesForPath(access, path),
    ...fields.flushesForPath(access, path)
  ].map((args) => resourceWrite.create(args));
  const segments = new SegmentState(fields);

  return {
    values,
    nodes,
    pending: {
      read: (channel, options) => channel.kind === "gpr"
        ? gpr.readChannel(access, channel, options)
        : fields.read(access, channel),
      write: (channel, value) => {
        if (channel.kind === "gpr") {
          gpr.writeChannel(access, channel, value);
          return;
        }

        if (channel.kind === "segment") {
          throw new Error("segment writes must use a segment-load host exit");
        }

        fields.write(channel, value);
      },
      has: (channel) => channel.kind === "gpr" ? gpr.has(channel) : fields.has(channel),
      beginInstruction: () => {
        gpr.beginInstruction();
        fields.beginInstruction();
      },
      flushesForPath,
      readDynamicGpr: (index, width, options) =>
        gpr.readDynamic(access, index, width, options),
      writeDynamicGpr: (index, width, value) =>
        gpr.writeDynamic(access, index, width, value),
      readDynamicSegmentBase: (index) => segments.readDynamicBase(access, index),
      readDynamicSegmentSelector: (index) =>
        segments.readDynamicSelector(access, index, 16, {})
    }
  };
}

function faultFlushEntries(
  pending: PendingHarness
): ReadonlyArray<readonly [ResourceEffect, ValueId]> {
  return edgeEntries(pending.flushesForPath("fault"));
}

function completedEdgeEntries(
  pending: PendingHarness
): ReadonlyArray<readonly [ResourceEffect, ValueId]> {
  return edgeEntries(pending.flushesForPath("completed"));
}

function edgeEntries(
  writes: readonly StateWriteOperation[]
): ReadonlyArray<readonly [ResourceEffect, ValueId]> {
  return writes.map((write) => [write.effect, stateWriteValue(write)] as const);
}

function edgeEntry(
  values: ValueTable,
  channel: InstructionStateChannel,
  value: ValueId
): readonly [ResourceEffect, ValueId] {
  return [stateEffect(values, channel), value];
}

test("a GPR pending hit returns the value with no nodes", () => {
  const { values, nodes, pending } = createHarness();
  const value = values.const(0x12345678);

  pending.write(gprChannel("eax"), value);
  strictEqual(pending.read(gprChannel("eax")), value);
  deepStrictEqual(nodes, []);
});

test("sibling narrow GPR reads normalize independently", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const gpr = new GprState(stateAccess);
  const input = values.external(0);

  gpr.writeChannel(stateAccess.bind(root), gprChannel("al"), input);

  const first = root.child();
  const firstByte = gpr.readChannel(
    stateAccess.bind(first),
    gprChannel("al"),
    { signed: true }
  );
  const second = root.child();
  const secondByte = gpr.readChannel(
    stateAccess.bind(second),
    gprChannel("al"),
    { signed: true }
  );

  notStrictEqual(
    firstByte,
    secondByte,
    "a retained ancestor value view would collapse the sibling reads"
  );
  deepStrictEqual(values.node(firstByte), {
    kind: "extend",
    resultType: "i32",
    width: 8,
    value: input,
    signed: true
  });
  deepStrictEqual(values.node(secondByte), values.node(firstByte));
  strictEqual(first.values.extend(8, input, true), firstByte);
  strictEqual(second.values.extend(8, input, true), secondByte);
});

test("sibling segment-selector reads normalize independently", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const fields = new StateFieldTracker(stateAccess);
  const segments = new SegmentState(fields);
  const selector = values.external(0);

  fields.write(segmentSelectorChannel("fs"), selector);

  const first = root.child();
  const firstSelector = segments.readSelector(
    stateAccess.bind(first),
    "fs",
    16,
    { signed: true }
  );
  const second = root.child();
  const secondSelector = segments.readSelector(
    stateAccess.bind(second),
    "fs",
    16,
    { signed: true }
  );

  notStrictEqual(
    firstSelector,
    secondSelector,
    "a retained ancestor value view would collapse the sibling reads"
  );
  deepStrictEqual(values.node(firstSelector), {
    kind: "extend",
    resultType: "i32",
    width: 16,
    value: selector,
    signed: true
  });
  deepStrictEqual(values.node(secondSelector), values.node(firstSelector));
  strictEqual(first.values.extend(16, selector, true), firstSelector);
  strictEqual(second.values.extend(16, selector, true), secondSelector);
});

test("a read disjoint from all pendings loads through one cached resource read", () => {
  const { values, nodes, pending } = createHarness();

  pending.write(gprChannel("eax"), values.const(1));

  const first = pending.read(gprChannel("ebx"));

  strictEqual(pending.read(gprChannel("ebx")), first);
  deepStrictEqual(nodes, [stateRead(values, first, gprChannel("ebx"))]);
});

test("writing a GPR input value back leaves no pending store", () => {
  const { values, nodes, pending } = createHarness();
  const read = pending.read(gprChannel("eax"));

  pending.write(gprChannel("eax"), values.const(1));
  pending.write(gprChannel("eax"), read);

  strictEqual(pending.has(gprChannel("eax")), false);
  nodes.push(...pending.flushesForPath("completed"));

  deepStrictEqual(nodes, [stateRead(values, read, gprChannel("eax"))]);
});

test("writing a state-field input value back leaves no pending store", () => {
  const { values, nodes, pending } = createHarness();
  const read = pending.read(flagStateFields.concrete.ZF);

  pending.write(flagStateFields.concrete.ZF, values.const(1));
  pending.write(flagStateFields.concrete.ZF, read);

  strictEqual(pending.has(flagStateFields.concrete.ZF), false);
  nodes.push(...pending.flushesForPath("completed"));

  deepStrictEqual(nodes, [stateRead(values, read, flagStateFields.concrete.ZF)]);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const { values, nodes, pending } = createHarness();
  const byte = values.const(0x12);

  pending.write(gprChannel("al"), byte);

  const word = pending.read(gprChannel("eax"));

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("al"), byte),
    stateRead(values, word, gprChannel("eax"))
  ]);

  // The flushed al stays pending, clean: it serves reads with no new
  // nodes and never needs storing again.
  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.read(gprChannel("al")), byte);
  deepStrictEqual(pending.flushesForPath("completed"), []);
  strictEqual(nodes.length, 2);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x12345678);

  pending.write(gprChannel("eax"), word);

  // Deferred refinement: al could be served from the pending eax through a
  // truncation; ah always goes through memory.
  const byte = pending.read(gprChannel("al"));

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("eax"), word),
    stateRead(values, byte, gprChannel("al"))
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const { values, nodes, pending } = createHarness();

  pending.write(gprChannel("eax"), values.const(0x12345678));

  const high = pending.read(gprChannel("ah"));

  strictEqual(nodes.length, 2);
  deepStrictEqual(nodes[1], stateRead(values, high, gprChannel("ah")));
});

test("a covering write drops the pending with no flush", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x12345678);

  pending.write(gprChannel("al"), values.const(0x12));
  pending.write(gprChannel("ah"), values.const(0x34));
  pending.write(gprChannel("eax"), word);

  strictEqual(nodes.length, 0);
  nodes.push(...pending.flushesForPath("completed"));
  deepStrictEqual(nodes, [stateWrite(values, gprChannel("eax"), word)]);
});

test("a partially overlapping write flushes the wider pending first", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x12345678);
  const byte = values.const(0x9a);

  pending.write(gprChannel("ax"), word);
  pending.write(gprChannel("al"), byte);

  deepStrictEqual(nodes, [stateWrite(values, gprChannel("ax"), word)]);
  nodes.push(...pending.flushesForPath("completed"));
  deepStrictEqual(nodes[1], stateWrite(values, gprChannel("al"), byte));
});

test("disjoint byte pendings coexist and flush together on an ax read", () => {
  const { values, nodes, pending } = createHarness();
  const low = values.const(0x12);
  const high = values.const(0x34);
  const flag = values.const(1);

  pending.write(flagStateFields.concrete.ID, flag);
  pending.write(gprChannel("al"), low);
  pending.write(gprChannel("ah"), high);
  deepStrictEqual(nodes, []);

  const word = pending.read(gprChannel("ax"));

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("al"), low),
    stateWrite(values, gprChannel("ah"), high),
    stateRead(values, word, gprChannel("ax"))
  ]);

  // Flag pendings are untouched by register traffic.
  strictEqual(pending.has(flagStateFields.concrete.ID), true);
  strictEqual(pending.read(flagStateFields.concrete.ID), flag);
});

test("flag and eip pendings hit exactly and never interact with registers", () => {
  const { values, nodes, pending } = createHarness();
  const eip = values.const(0x401000);

  pending.write(coreStateFields.eip, eip);
  pending.write(gprChannel("eax"), values.const(7));
  strictEqual(pending.read(coreStateFields.eip), eip);
  deepStrictEqual(nodes, []);
});

test("lazy flag metadata fields are cached state fields", () => {
  const { values, nodes, pending } = createHarness();
  const kindByte = pending.read(flagStateFields.lazyKind);
  const lazyA = values.const(0x1234_5678);

  strictEqual(pending.read(flagStateFields.lazyKind), kindByte);
  strictEqual(values.truncate(8, kindByte), kindByte);

  pending.write(flagStateFields.lazyA, lazyA);

  strictEqual(pending.has(flagStateFields.lazyA), true);
  strictEqual(pending.read(flagStateFields.lazyA), lazyA);
  deepStrictEqual(nodes, [
    stateRead(values, kindByte, flagStateFields.lazyKind)
  ]);
  deepStrictEqual(pending.flushesForPath("completed"), [
    stateWrite(values, flagStateFields.lazyA, lazyA)
  ]);
});

test("segment channels are read-only cached state fields", () => {
  const { values, nodes, pending } = createHarness();
  const fsBase = pending.read(segmentBaseChannel("fs"));
  const fsSelector = pending.read(segmentSelectorChannel("fs"));

  strictEqual(pending.read(segmentBaseChannel("fs")), fsBase);
  strictEqual(pending.read(segmentSelectorChannel("fs")), fsSelector);
  strictEqual(values.truncate(16, fsSelector), fsSelector);

  throws(
    () => pending.write(segmentBaseChannel("fs"), values.const(0x1000)),
    /segment writes must use a segment-load host exit/
  );
  throws(
    () => pending.write(segmentSelectorChannel("fs"), values.const(0x23)),
    /segment writes must use a segment-load host exit/
  );
  deepStrictEqual(nodes, [
    stateRead(values, fsBase, segmentBaseChannel("fs")),
    stateRead(values, fsSelector, segmentSelectorChannel("fs"))
  ]);
});

test("dynamic segment reads keep selector and base fields separate", () => {
  const { values, nodes, pending } = createHarness();
  const index = values.const(3);
  const selector = pending.readDynamicSegmentSelector(index);
  const base = pending.readDynamicSegmentBase(index);

  strictEqual(values.truncate(16, selector), selector);
  deepStrictEqual(nodes, [
    dynamicSegmentRead(values, selector, index, "selector"),
    dynamicSegmentRead(values, base, index, "base")
  ]);
});

test("flag fields use state-field pending tracking", () => {
  const { values, nodes, pending } = createHarness();
  const zf = values.const(1);

  pending.write(flagStateFields.concrete.ZF, zf);

  strictEqual(pending.has(flagStateFields.concrete.ZF), true);
  strictEqual(pending.read(flagStateFields.concrete.ZF), zf);

  deepStrictEqual(pending.flushesForPath("completed"), [
    stateWrite(values, flagStateFields.concrete.ZF, zf)
  ]);
  deepStrictEqual(nodes, []);
});

test("a flush invalidates read leaves of overlapping channels only", () => {
  const { values, nodes, pending } = createHarness();
  const eaxRead = pending.read(gprChannel("eax"));
  const ecxRead = pending.read(gprChannel("ecx"));

  pending.write(gprChannel("al"), values.const(0x12));

  // The al flush makes the cached eax leaf stale; ecx is unaffected.
  const reloaded = pending.read(gprChannel("eax"));

  notStrictEqual(reloaded, eaxRead);
  strictEqual(pending.read(gprChannel("ecx")), ecxRead);
  strictEqual(nodes.filter((node) => isStateRead(node)).length, 3);
});

test("signed and unsigned reads of one channel are separate marked loads", () => {
  const { values, nodes, pending } = createHarness();
  const unsigned = pending.read(gprChannel("al"));
  const signed = pending.read(gprChannel("al"), { signed: true });

  notStrictEqual(signed, unsigned);
  strictEqual(pending.read(gprChannel("al")), unsigned);
  strictEqual(pending.read(gprChannel("al"), { signed: true }), signed);
  deepStrictEqual(nodes, [
    stateRead(values, unsigned, gprChannel("al")),
    stateRead(values, signed, gprChannel("al"), true)
  ]);
});

test("a signed read of a full-width channel is the plain read", () => {
  const { values, nodes, pending } = createHarness();
  const read = pending.read(gprChannel("eax"), { signed: true });

  strictEqual(pending.read(gprChannel("eax")), read);
  deepStrictEqual(nodes, [stateRead(values, read, gprChannel("eax"))]);
});

test("a narrow GPR hit normalizes values whose high bits are unproven", () => {
  const { values, pending } = createHarness();
  const unproven = values.addNodeOutput();

  pending.write(gprChannel("al"), unproven);
  strictEqual(pending.read(gprChannel("al")), values.truncate(8, unproven));
  strictEqual(
    pending.read(gprChannel("al"), { signed: true }),
    values.extend(8, unproven, true)
  );

  // A value that provably fits the channel passes through untouched.
  const byte = values.const(0x12);

  pending.write(gprChannel("ah"), byte);
  strictEqual(pending.read(gprChannel("ah")), byte);
});

test("completed edge flushes dirty pendings in owner order", () => {
  const { values, pending } = createHarness();
  const flag = values.const(1);
  const word = values.const(7);

  pending.write(flagStateFields.concrete.DF, flag);
  pending.write(gprChannel("esi"), word);

  deepStrictEqual(pending.flushesForPath("completed"), [
    stateWrite(values, gprChannel("esi"), word),
    stateWrite(values, flagStateFields.concrete.DF, flag)
  ]);

  strictEqual(pending.read(flagStateFields.concrete.DF), flag);
  strictEqual(pending.read(gprChannel("esi")), word);
});

test("fault boundary lists instruction-start values without consuming the map", () => {
  const { values, nodes, pending } = createHarness();
  const byte = values.const(0x12);
  const eip = values.const(0x1000);

  pending.write(gprChannel("al"), byte);
  pending.write(coreStateFields.eip, eip);
  pending.beginInstruction();

  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("al"), byte),
    edgeEntry(values, coreStateFields.eip, eip)
  ]);
  deepStrictEqual(nodes, []);
  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.has(coreStateFields.eip), true);
});

test("fault boundary keeps a rewritten channel's instruction-start value", () => {
  const { values, pending } = createHarness();
  const before = values.const(1);
  const after = values.const(2);

  pending.write(gprChannel("eax"), before);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), after);

  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("eax"), before)
  ]);
  strictEqual(pending.read(gprChannel("eax")), after);
});

test("fault boundary omits a channel first written this instruction", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(1));

  deepStrictEqual(faultFlushEntries(pending), []);
});

test("a covering write keeps the dropped channel's start value in the fault boundary", () => {
  const { values, pending } = createHarness();
  const byte = values.const(0x12);

  pending.write(gprChannel("al"), byte);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(0x12345678));

  // eax had no start pending (omitted); the dropped al still must reach
  // cpu state memory on the fault path.
  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("al"), byte)
  ]);
});

test("flushing a channel first written this instruction makes the fault boundary unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("al"), values.const(1));
  pending.read(gprChannel("ax"));

  throws(() => pending.flushesForPath("fault"), /unrestorable/);

  // The next instruction boundary takes a fresh copy; the flushed al is
  // clean but still pending, so it joins the new boundary.
  pending.beginInstruction();
  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("al"), values.const(1))
  ]);
});

test("flushing a channel rewritten this instruction keeps its start value in the fault boundary", () => {
  const { values, pending } = createHarness();
  const before = values.const(0x111);

  pending.write(gprChannel("eax"), before);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(0x222));
  pending.read(gprChannel("al"));

  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("eax"), before)
  ]);
});

test("flushing a channel untouched this instruction keeps it in the fault boundary", () => {
  const { values, pending } = createHarness();
  const byte = values.const(0x12);

  pending.write(gprChannel("al"), byte);
  pending.beginInstruction();
  pending.read(gprChannel("ax"));

  // The flush already stored this value; rewriting it is harmless.
  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("al"), byte)
  ]);
});

test("a covering write drops a clean pending without a store", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x12345678);

  pending.write(gprChannel("al"), values.const(0x12));
  pending.read(gprChannel("eax"));
  pending.write(gprChannel("eax"), word);
  nodes.push(...pending.flushesForPath("completed"));

  // One al store (the flush before the read); the covering eax write drops
  // the clean al, so only eax flushes at the end.
  strictEqual(isStateWrite(nodes[0]!), true);
  deepStrictEqual(nodes[2], stateWrite(values, gprChannel("eax"), word));
  strictEqual(nodes.length, 3);
});

test("completed edge lists only dirty pendings", () => {
  const { values, pending } = createHarness();
  const byte = values.const(0x12);
  const flag = values.const(1);

  pending.write(gprChannel("al"), byte);
  pending.write(flagStateFields.concrete.ID, flag);
  pending.read(gprChannel("ax"));

  // The ax read flushed al; only the flag is still dirty.
  deepStrictEqual(completedEdgeEntries(pending), [
    edgeEntry(values, flagStateFields.concrete.ID, flag)
  ]);
});

test("a dynamic read flushes dirty GPR pendings and leaves them clean", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x77);
  const flag = values.const(1);
  const index = values.external(0);

  pending.write(gprChannel("eax"), word);
  pending.write(flagStateFields.concrete.ID, flag);

  const first = pending.readDynamicGpr(index, 32);

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("eax"), word),
    dynamicGprRead(values, first, index, 32)
  ]);

  // eax is clean: it still serves reads and the next dynamic read flushes
  // nothing. Each dynamic read loads fresh — the channel is unknown.
  strictEqual(pending.read(gprChannel("eax")), word);

  const second = pending.readDynamicGpr(index, 32);

  notStrictEqual(second, first);
  deepStrictEqual(nodes[2], dynamicGprRead(values, second, index, 32));
  strictEqual(nodes.length, 3);
  strictEqual(pending.read(flagStateFields.concrete.ID), flag);
});

test("a dynamic write stores immediately and invalidates every GPR pending", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x77);
  const flag = values.const(1);
  const eip = values.const(0x1000);
  const stored = values.const(0x222);
  const index = values.external(0);

  pending.write(gprChannel("eax"), word);
  pending.write(flagStateFields.concrete.DF, flag);
  pending.write(coreStateFields.eip, eip);
  pending.writeDynamicGpr(index, 32, stored);

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("eax"), word),
    dynamicGprWrite(values, index, 32, stored)
  ]);

  // The just-cleaned eax is gone too — the store may have hit its word —
  // while flag and eip pendings ride through.
  const reload = pending.read(gprChannel("eax"));

  deepStrictEqual(nodes[2], stateRead(values, reload, gprChannel("eax")));
  strictEqual(pending.read(flagStateFields.concrete.DF), flag);
  strictEqual(pending.read(coreStateFields.eip), eip);
});

test("a dynamic write invalidates cached GPR read leaves but not flag leaves", () => {
  const { values, pending } = createHarness();
  const index = values.external(0);
  const eaxRead = pending.read(gprChannel("eax"));
  const zfRead = pending.read(flagStateFields.concrete.ID);

  pending.writeDynamicGpr(index, 32, values.const(1));

  notStrictEqual(pending.read(gprChannel("eax")), eaxRead);
  strictEqual(pending.read(flagStateFields.concrete.ID), zfRead);
});

test("a dynamic write makes the fault boundary unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.writeDynamicGpr(values.external(0), 32, values.const(1));

  throws(() => pending.flushesForPath("fault"), /unrestorable/);

  // The next instruction boundary takes a fresh copy.
  pending.beginInstruction();
  deepStrictEqual(faultFlushEntries(pending), []);
});

test("a dynamic read flushing a channel first written this instruction makes the fault boundary unrestorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("ebx"), values.const(0x111));
  pending.readDynamicGpr(values.external(0), 32);

  throws(() => pending.flushesForPath("fault"), /unrestorable/);
});

test("a dynamic read flushing a boundary pending keeps the fault boundary restorable", () => {
  const { values, pending } = createHarness();
  const before = values.const(0x111);

  pending.write(gprChannel("ebx"), before);
  pending.beginInstruction();
  pending.readDynamicGpr(values.external(0), 32);

  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("ebx"), before)
  ]);
});

test("a destructive flush served by a cached read keeps the fault boundary restorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();

  const before = pending.read(gprChannel("esp"));

  pending.write(gprChannel("esp"), values.const(0x44));
  pending.readDynamicGpr(values.external(0), 32);

  // The cached read is the pre-instruction value — no store hit esp before
  // its first flush — so it joins the boundary instead of latching the
  // unrestorable assert.
  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("esp"), before)
  ]);
});

test("a signed cached read serves a destructive flush of its channel", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();

  const before = pending.read(gprChannel("al"), { signed: true });

  pending.write(gprChannel("al"), values.const(0x12));
  pending.read(gprChannel("ax"));

  // The sign-extended read's low channel-width bits are the memory bytes;
  // the channel-width boundary store masks the rest.
  deepStrictEqual(faultFlushEntries(pending), [
    edgeEntry(values, gprChannel("al"), before)
  ]);
});

test("narrow dynamic reads carry their byte length, bounds, and sign marker", () => {
  const { values, nodes, pending } = createHarness();
  const index = values.external(0);
  const unsigned = pending.readDynamicGpr(index, 8);
  const signed = pending.readDynamicGpr(index, 8, { signed: true });

  deepStrictEqual(nodes, [
    dynamicGprRead(values, unsigned, index, 8),
    dynamicGprRead(values, signed, index, 8, true)
  ]);

  // Bounds match static narrow channels: no masks or extends downstream.
  strictEqual(values.truncate(8, unsigned), unsigned);
  strictEqual(values.extend(8, signed, true), signed);
});

test("a signed dynamic word read is the plain read", () => {
  const { values, nodes, pending } = createHarness();
  const index = values.external(0);
  const read = pending.readDynamicGpr(index, 32, { signed: true });

  deepStrictEqual(nodes, [dynamicGprRead(values, read, index, 32)]);
});

test("a narrow dynamic write barriers word pendings all the same", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x12345678);
  const byte = values.const(0x9a);
  const index = values.external(0);

  pending.write(gprChannel("eax"), word);
  pending.writeDynamicGpr(index, 8, byte);

  deepStrictEqual(nodes, [
    stateWrite(values, gprChannel("eax"), word),
    dynamicGprWrite(values, index, 8, byte)
  ]);

  const reload = pending.read(gprChannel("eax"));

  deepStrictEqual(nodes[2], stateRead(values, reload, gprChannel("eax")));
});
