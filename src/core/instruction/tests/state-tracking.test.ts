import {
  notStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { RegionBuilder } from "#compiler/ir/builder/region.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { flagStateFields } from "#core/flags/layout.js";
import { StateAccess } from "#core/state/access.js";
import {
  gprChannel,
  segmentBaseChannel,
  segmentSelectorChannel
} from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { OperandWidth } from "#core/types.js";
import { cpuState } from "#test/support/execution-model.js";
import { GprState, type GprReadOptions } from "../state/gpr.js";
import { StateFieldTracker } from "../state/field-tracker.js";
import type { StatePathKind } from "../state/pending-buffer.js";
import { SegmentState } from "../state/segments.js";
import type { InstructionStateChannel } from "../state/channels.js";
import {
  isStateRead,
  isStateWrite,
  readsStateChannel,
  stateWriteValue,
  writesStateChannel,
  type StateReadOperation,
  type StateWriteOperation
} from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  nodes(): readonly RegionNode[];
  pending: PendingHarness;
}>;

type PendingHarness = Readonly<{
  read(channel: InstructionStateChannel, options?: GprReadOptions): ValueId;
  write(channel: InstructionStateChannel, value: ValueId): void;
  has(channel: InstructionStateChannel): boolean;
  beginInstruction(): void;
  flushesForPath(path: StatePathKind): readonly StateWriteOperation[];
  readDynamicGpr(
    index: ValueId,
    width: OperandWidth,
    options?: GprReadOptions
  ): ValueId;
  writeDynamicGpr(index: ValueId, width: OperandWidth, value: ValueId): void;
  readDynamicSegmentBase(index: ValueId): ValueId;
  readDynamicSegmentSelector(index: ValueId): ValueId;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const access = stateAccess.bind(body);
  const fields = new StateFieldTracker(stateAccess);
  const gpr = new GprState(stateAccess);
  const segments = new SegmentState(fields);

  return {
    values,
    nodes: () => body.build().nodes,
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
      has: (channel) =>
        channel.kind === "gpr" ? gpr.has(channel) : fields.has(channel),
      beginInstruction: () => {
        gpr.beginInstruction();
        fields.beginInstruction();
      },
      flushesForPath: (path) => [
        ...gpr.flushesForPath(access, path),
        ...fields.flushesForPath(access, path)
      ].map((args) => resourceWrite.create(args)),
      readDynamicGpr: (index, width, options) =>
        gpr.readDynamic(access, index, width, options),
      writeDynamicGpr: (index, width, value) =>
        gpr.writeDynamic(access, index, width, value),
      readDynamicSegmentBase: (index) =>
        segments.readDynamicBase(access, index),
      readDynamicSegmentSelector: (index) =>
        segments.readDynamicSelector(access, index, 16, {})
    }
  };
}

function readsFor(
  values: ValueTable,
  nodes: readonly RegionNode[],
  channel: InstructionStateChannel
): StateReadOperation[] {
  return nodes.filter((node): node is StateReadOperation =>
    readsStateChannel(values, node, channel)
  );
}

function writesFor(
  values: ValueTable,
  nodes: readonly RegionNode[],
  channel: InstructionStateChannel
): StateWriteOperation[] {
  return nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(values, node, channel)
  );
}

test("pending values hit directly while disjoint reads load once", () => {
  const { values, nodes, pending } = createHarness();
  const eax = values.const(0x1234_5678);

  pending.write(gprChannel("eax"), eax);
  strictEqual(pending.read(gprChannel("eax")), eax);
  strictEqual(nodes().length, 0);

  const firstEbx = pending.read(gprChannel("ebx"));

  strictEqual(pending.read(gprChannel("ebx")), firstEbx);
  const ebxReads = readsFor(values, nodes(), gprChannel("ebx"));

  strictEqual(ebxReads.length, 1);
  strictEqual(ebxReads[0]!.outputs[0], firstEbx);
});

test("writing an input value back cancels a pending store", () => {
  for (const channel of [
    gprChannel("eax"),
    flagStateFields.concrete.ZF
  ] as const) {
    const { values, pending } = createHarness();
    const input = pending.read(channel);

    pending.write(channel, values.const(1));
    pending.write(channel, input);

    strictEqual(pending.has(channel), false);
    strictEqual(pending.flushesForPath("completed").length, 0);
  }
});

test("overlapping aliases flush before a differently sized read", () => {
  const cases = [
    { written: gprChannel("al"), read: gprChannel("eax") },
    { written: gprChannel("eax"), read: gprChannel("al") },
    { written: gprChannel("eax"), read: gprChannel("ah") },
    { written: gprChannel("ax"), read: gprChannel("al") }
  ] as const;

  for (const entry of cases) {
    const { values, nodes, pending } = createHarness();
    const value = values.const(0x1234_5678);

    pending.write(entry.written, value);
    const reloaded = pending.read(entry.read);
    const writeIndex = nodes().findIndex((node) =>
      writesStateChannel(values, node, entry.written)
    );
    const readIndex = nodes().findIndex((node) =>
      readsStateChannel(values, node, entry.read)
    );

    ok(
      writeIndex >= 0 && readIndex > writeIndex,
      `${entry.written.reg} must commit before reading ${entry.read.reg}`
    );
    strictEqual(
      readsFor(values, nodes(), entry.read)[0]?.outputs[0],
      reloaded
    );
  }
});

test("a covering write drops narrower dirty aliases", () => {
  const { values, nodes, pending } = createHarness();
  const word = values.const(0x1234_5678);

  pending.write(gprChannel("al"), values.const(0x12));
  pending.write(gprChannel("ah"), values.const(0x34));
  pending.write(gprChannel("eax"), word);

  strictEqual(nodes().length, 0);
  const completed = pending.flushesForPath("completed");

  strictEqual(writesFor(values, completed, gprChannel("al")).length, 0);
  strictEqual(writesFor(values, completed, gprChannel("ah")).length, 0);
  const eaxWrites = writesFor(values, completed, gprChannel("eax"));

  strictEqual(eaxWrites.length, 1);
  strictEqual(stateWriteValue(eaxWrites[0]!), word);
});

test("disjoint byte aliases coexist until a covering read", () => {
  const { values, nodes, pending } = createHarness();
  const low = values.const(0x12);
  const high = values.const(0x34);
  const flag = values.const(1);

  pending.write(gprChannel("al"), low);
  pending.write(gprChannel("ah"), high);
  pending.write(flagStateFields.concrete.ID, flag);

  const ax = pending.read(gprChannel("ax"));

  strictEqual(writesFor(values, nodes(), gprChannel("al")).length, 1);
  strictEqual(writesFor(values, nodes(), gprChannel("ah")).length, 1);
  strictEqual(readsFor(values, nodes(), gprChannel("ax"))[0]?.outputs[0], ax);
  strictEqual(pending.read(flagStateFields.concrete.ID), flag);
});

test("narrow cached values normalize only when their bounds require it", () => {
  const { values, pending } = createHarness();
  const unproven = values.addNodeOutput();

  pending.write(gprChannel("al"), unproven);

  strictEqual(
    pending.read(gprChannel("al")),
    values.truncate(8, unproven)
  );
  strictEqual(
    pending.read(gprChannel("al"), { signed: true }),
    values.extend(8, unproven, true)
  );

  const byte = values.const(0x12);

  pending.write(gprChannel("ah"), byte);
  strictEqual(pending.read(gprChannel("ah")), byte);
});

test("signed and unsigned narrow loads are cached separately", () => {
  const { values, nodes, pending } = createHarness();
  const unsigned = pending.read(gprChannel("al"));
  const signed = pending.read(gprChannel("al"), { signed: true });

  notStrictEqual(unsigned, signed);
  strictEqual(pending.read(gprChannel("al")), unsigned);
  strictEqual(pending.read(gprChannel("al"), { signed: true }), signed);

  const reads = readsFor(values, nodes(), gprChannel("al"));

  strictEqual(reads.length, 2);
  strictEqual(reads.filter((read) => read.signed === true).length, 1);
  strictEqual(values.truncate(8, unsigned), unsigned);
  strictEqual(values.extend(8, signed, true), signed);
});

test("state fields cache values and completed paths flush only dirty fields", () => {
  const { values, nodes, pending } = createHarness();
  const lazyA = values.const(0x1234_5678);
  const id = values.const(1);

  const lazyKind = pending.read(flagStateFields.lazyKind);

  strictEqual(pending.read(flagStateFields.lazyKind), lazyKind);
  pending.write(flagStateFields.lazyA, lazyA);
  pending.write(flagStateFields.concrete.ID, id);

  strictEqual(readsFor(values, nodes(), flagStateFields.lazyKind).length, 1);
  const completed = pending.flushesForPath("completed");
  const lazyAWrites = writesFor(values, completed, flagStateFields.lazyA);
  const idWrites = writesFor(
    values,
    completed,
    flagStateFields.concrete.ID
  );

  strictEqual(lazyAWrites.length, 1);
  strictEqual(stateWriteValue(lazyAWrites[0]!), lazyA);
  strictEqual(idWrites.length, 1);
  strictEqual(stateWriteValue(idWrites[0]!), id);
});

test("segment channels are cached reads but cannot become ordinary pendings", () => {
  const { values, nodes, pending } = createHarness();
  const selector = pending.read(segmentSelectorChannel("fs"));
  const base = pending.read(segmentBaseChannel("fs"));

  strictEqual(pending.read(segmentSelectorChannel("fs")), selector);
  strictEqual(pending.read(segmentBaseChannel("fs")), base);
  strictEqual(values.truncate(16, selector), selector);
  strictEqual(readsFor(
    values,
    nodes(),
    segmentSelectorChannel("fs")
  ).length, 1);
  strictEqual(readsFor(values, nodes(), segmentBaseChannel("fs")).length, 1);

  throws(
    () => pending.write(segmentSelectorChannel("fs"), values.const(0x23)),
    /segment writes must use a segment-load host exit/
  );
});

test("dynamic segment selector and base reads stay distinct", () => {
  const { values, nodes, pending } = createHarness();
  const index = values.parameter(0, "i32");
  const selector = pending.readDynamicSegmentSelector(index);
  const base = pending.readDynamicSegmentBase(index);
  const reads = nodes().filter(isStateRead);

  strictEqual(reads.length, 2);
  strictEqual(reads[0]!.outputs[0], selector);
  strictEqual(reads[1]!.outputs[0], base);
  strictEqual(reads[0]!.width, 16);
  strictEqual(reads[1]!.width, 32);
  strictEqual(values.truncate(16, selector), selector);
});

test("completed paths omit pendings already committed by an alias barrier", () => {
  const { values, pending } = createHarness();
  const al = values.const(0x12);
  const flag = values.const(1);

  pending.write(gprChannel("al"), al);
  pending.write(flagStateFields.concrete.ID, flag);
  pending.read(gprChannel("ax"));

  const completed = pending.flushesForPath("completed");

  strictEqual(writesFor(values, completed, gprChannel("al")).length, 0);
  const flagWrites = writesFor(
    values,
    completed,
    flagStateFields.concrete.ID
  );

  strictEqual(flagWrites.length, 1);
  strictEqual(stateWriteValue(flagWrites[0]!), flag);
});

test("fault paths restore boundary values and omit new writes", () => {
  const { values, pending } = createHarness();
  const before = values.const(1);
  const after = values.const(2);

  pending.write(gprChannel("eax"), before);
  pending.write(coreStateFields.eip, values.const(0x1000));
  pending.beginInstruction();
  pending.write(gprChannel("eax"), after);
  pending.write(gprChannel("ecx"), values.const(3));

  const fault = pending.flushesForPath("fault");
  const eaxFaultWrites = writesFor(values, fault, gprChannel("eax"));

  strictEqual(eaxFaultWrites.length, 1);
  strictEqual(stateWriteValue(eaxFaultWrites[0]!), before);
  strictEqual(writesFor(values, fault, gprChannel("ecx")).length, 0);
  strictEqual(
    writesFor(values, fault, coreStateFields.eip).length,
    1
  );
  strictEqual(pending.read(gprChannel("eax")), after);
});

test("covering writes preserve a dropped alias from the fault boundary", () => {
  const { values, pending } = createHarness();
  const before = values.const(0x12);

  pending.write(gprChannel("al"), before);
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(0x1234_5678));

  const fault = pending.flushesForPath("fault");
  const alWrites = writesFor(values, fault, gprChannel("al"));

  strictEqual(alWrites.length, 1);
  strictEqual(stateWriteValue(alWrites[0]!), before);
  strictEqual(writesFor(values, fault, gprChannel("eax")).length, 0);
});

test("destructive flushes require a restorable instruction-start value", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("al"), values.const(1));
  pending.read(gprChannel("ax"));

  throws(() => pending.flushesForPath("fault"), /unrestorable/);

  pending.beginInstruction();
  strictEqual(
    writesFor(
      values,
      pending.flushesForPath("fault"),
      gprChannel("al")
    ).length,
    1
  );
});

test("a cached boundary read makes a later destructive flush restorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  const before = pending.read(gprChannel("esp"));

  pending.write(gprChannel("esp"), values.const(0x44));
  pending.readDynamicGpr(values.parameter(0, "i32"), 32);

  const faultWrites = writesFor(
    values,
    pending.flushesForPath("fault"),
    gprChannel("esp")
  );

  strictEqual(faultWrites.length, 1);
  strictEqual(stateWriteValue(faultWrites[0]!), before);
});

test("dynamic reads flush GPR pendings but leave other state cached", () => {
  const { values, nodes, pending } = createHarness();
  const eax = values.const(0x77);
  const flag = values.const(1);
  const index = values.parameter(0, "i32");

  pending.write(gprChannel("eax"), eax);
  pending.write(flagStateFields.concrete.ID, flag);

  const first = pending.readDynamicGpr(index, 32);
  const second = pending.readDynamicGpr(index, 32);
  const dynamicReads = nodes().filter(isStateRead);

  notStrictEqual(first, second);
  strictEqual(dynamicReads.length, 2);
  strictEqual(writesFor(values, nodes(), gprChannel("eax")).length, 1);
  strictEqual(pending.read(gprChannel("eax")), eax);
  strictEqual(pending.read(flagStateFields.concrete.ID), flag);
});

test("dynamic writes invalidate GPR state without disturbing other channels", () => {
  const { values, nodes, pending } = createHarness();
  const index = values.parameter(0, "i32");
  const oldRead = pending.read(gprChannel("eax"));
  const flag = pending.read(flagStateFields.concrete.ID);
  const eip = values.const(0x1000);
  const stored = values.const(0x222);

  pending.write(coreStateFields.eip, eip);
  pending.writeDynamicGpr(index, 8, stored);

  const dynamicWrites = nodes().filter(isStateWrite);

  strictEqual(dynamicWrites.length, 1);
  strictEqual(dynamicWrites[0]!.width, 8);
  strictEqual(stateWriteValue(dynamicWrites[0]!), stored);
  notStrictEqual(pending.read(gprChannel("eax")), oldRead);
  strictEqual(pending.read(flagStateFields.concrete.ID), flag);
  strictEqual(pending.read(coreStateFields.eip), eip);
});

test("dynamic GPR barriers make new instruction writes unrestorable", () => {
  const dynamicWrite = createHarness();

  dynamicWrite.pending.beginInstruction();
  dynamicWrite.pending.writeDynamicGpr(
    dynamicWrite.values.parameter(0, "i32"),
    32,
    dynamicWrite.values.const(1)
  );
  throws(
    () => dynamicWrite.pending.flushesForPath("fault"),
    /unrestorable/
  );

  const dynamicRead = createHarness();

  dynamicRead.pending.beginInstruction();
  dynamicRead.pending.write(
    gprChannel("ebx"),
    dynamicRead.values.const(1)
  );
  dynamicRead.pending.readDynamicGpr(
    dynamicRead.values.parameter(0, "i32"),
    32
  );
  throws(
    () => dynamicRead.pending.flushesForPath("fault"),
    /unrestorable/
  );
});

test("sibling narrow reads retain independent region-local value views", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const gpr = new GprState(stateAccess);
  const input = values.parameter(0, "i32");

  gpr.writeChannel(stateAccess.bind(root), gprChannel("al"), input);

  const first = root.child();
  const second = root.child();
  const firstByte = gpr.readChannel(
    stateAccess.bind(first),
    gprChannel("al"),
    { signed: true }
  );
  const secondByte = gpr.readChannel(
    stateAccess.bind(second),
    gprChannel("al"),
    { signed: true }
  );

  notStrictEqual(firstByte, secondByte);
  strictEqual(first.values.extend(8, input, true), firstByte);
  strictEqual(second.values.extend(8, input, true), secondByte);
});
