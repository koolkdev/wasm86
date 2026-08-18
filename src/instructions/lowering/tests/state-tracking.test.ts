import { doesNotThrow, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { covers } from "#compiler/function/storage.js";
import { RegionBuilder } from "#compiler/function/builder/region.js";
import { i32, u8, type Integer, type I32Value } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { flagStateFields } from "#core/flags/layout.js";
import { StateAccess } from "#core/state/access.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { OperandWidth } from "#core/types.js";
import { cpuState } from "#test/support/execution-model.js";
import { StateFieldTracker } from "../state/field-tracker.js";
import { gprValueAsI32, GprState } from "../state/gpr.js";
import type { InstructionStateChannel } from "../state/channels.js";
import type { StatePathKind } from "../state/pending-buffer.js";
import type { StateWriteback } from "../state/writeback.js";
import { stateEffect } from "./state-operations.js";

type Harness = Readonly<{
  dynamicIndex: Integer<8>;
  pending: PendingHarness;
}>;

type PendingHarness = Readonly<{
  read(channel: InstructionStateChannel): I32Value;
  write(channel: InstructionStateChannel, value: I32Value): void;
  has(channel: InstructionStateChannel): boolean;
  isDirty(channel: InstructionStateChannel): boolean;
  beginInstruction(): void;
  flushesForPath(path: StatePathKind): readonly StateWriteback[];
  readDynamicGpr<Width extends OperandWidth>(index: Integer<8>, width: Width): Integer<Width>;
  writeDynamicGpr(index: Integer<8>, width: OperandWidth, value: I32Value): void;
}>;

function createHarness(): Harness {
  const values = new ValueResolver();
  const body = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const access = stateAccess.forRegion(body);
  const fields = new StateFieldTracker(stateAccess);
  const gpr = new GprState(stateAccess);
  const dynamicIndex = body.read(body.variable(u8(0)));

  return {
    dynamicIndex,
    pending: {
      read: (channel) =>
        channel.kind === "gpr"
          ? gprValueAsI32(gpr.readChannel(access, channel))
          : fields.read(access, channel),
      write: (channel, value) => {
        if (channel.kind === "gpr") {
          gpr.writeChannel(access, channel, value);
          return;
        }

        fields.write(access, channel, value);
      },
      has: (channel) => (channel.kind === "gpr" ? gpr.has(channel) : fields.has(channel)),
      isDirty: (channel) =>
        channel.kind === "gpr" ? gpr.isChannelDirty(channel) : fields.isDirty(channel),
      beginInstruction: () => {
        gpr.beginInstruction();
        fields.beginInstruction();
      },
      flushesForPath: (path) => [
        ...gpr.flushesForPath(access, path),
        ...fields.flushesForPath(access, path)
      ],
      readDynamicGpr: (index, width) => gpr.readDynamic(access, index, width),
      writeDynamicGpr: (index, width, value) => {
        switch (width) {
          case 8:
            gpr.writeDynamic(access, index, width, value.truncate(8));
            return;
          case 16:
            gpr.writeDynamic(access, index, width, value.truncate(16));
            return;
          case 32:
            gpr.writeDynamic(access, index, width, value);
            return;
        }
      }
    }
  };
}

function hasWriteback(
  writebacks: readonly StateWriteback[],
  channel: InstructionStateChannel
): boolean {
  const effect = stateEffect(channel);

  return writebacks.some(
    (writeback) => covers(effect, writeback.effect) && covers(writeback.effect, effect)
  );
}

test("writing an input value back cancels pending state", () => {
  for (const channel of [gprChannel("eax"), flagStateFields.concrete.ZF] as const) {
    const { pending } = createHarness();
    const input = pending.read(channel);

    pending.write(channel, i32(1));
    strictEqual(pending.has(channel), true);

    pending.write(channel, input);
    strictEqual(pending.has(channel), false);
  }
});

test("narrow GPR inputs retain their width and cancel matching writeback", () => {
  const values = new ValueResolver();
  const body = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const access = stateAccess.forRegion(body);
  const gpr = new GprState(stateAccess);
  const al = gpr.read(access, "al");

  strictEqual(al.width, 8);
  gpr.write(access, "al", i32(1).truncate(8));
  strictEqual(gpr.has(gprChannel("al")), true);
  gpr.write(access, "al", al);
  strictEqual(gpr.has(gprChannel("al")), false);

  const ax = gpr.read(access, "ax");

  strictEqual(ax.width, 16);
  gpr.write(access, "ax", i32(1).truncate(16));
  strictEqual(gpr.has(gprChannel("ax")), true);
  gpr.write(access, "ax", ax);
  strictEqual(gpr.has(gprChannel("ax")), false);
});

test("a covering GPR write replaces narrower pending aliases", () => {
  const { pending } = createHarness();

  pending.write(gprChannel("al"), i32(0x12));
  pending.write(gprChannel("ah"), i32(0x34));

  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.has(gprChannel("ah")), true);

  pending.write(gprChannel("eax"), i32(0x1234_5678));

  strictEqual(pending.has(gprChannel("al")), false);
  strictEqual(pending.has(gprChannel("ah")), false);
  strictEqual(pending.has(gprChannel("eax")), true);
});

test("an alias read publishes pending GPR bytes without disturbing other state", () => {
  const { pending } = createHarness();

  pending.write(gprChannel("al"), i32(0x12));
  pending.write(gprChannel("ah"), i32(0x34));
  pending.write(flagStateFields.concrete.ID, i32(1));

  strictEqual(pending.isDirty(gprChannel("ax")), true);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);

  pending.read(gprChannel("ax"));

  strictEqual(pending.isDirty(gprChannel("ax")), false);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);
});

test("fault paths restore the instruction boundary rather than current writes", () => {
  const { pending } = createHarness();

  pending.write(gprChannel("eax"), i32(1));
  pending.write(coreStateFields.eip, i32(0x1000));
  pending.beginInstruction();
  pending.write(gprChannel("eax"), i32(2));
  pending.write(gprChannel("ecx"), i32(3));

  const fault = pending.flushesForPath("fault");
  const completed = pending.flushesForPath("completed");

  strictEqual(hasWriteback(fault, gprChannel("eax")), true);
  strictEqual(hasWriteback(fault, coreStateFields.eip), true);
  strictEqual(hasWriteback(fault, gprChannel("ecx")), false);
  strictEqual(hasWriteback(completed, gprChannel("eax")), true);
  strictEqual(hasWriteback(completed, coreStateFields.eip), true);
  strictEqual(hasWriteback(completed, gprChannel("ecx")), true);
});

test("covering writes preserve a narrower fault-boundary channel", () => {
  const { pending } = createHarness();

  pending.write(gprChannel("al"), i32(0x12));
  pending.beginInstruction();
  pending.write(gprChannel("eax"), i32(0x1234_5678));

  const fault = pending.flushesForPath("fault");

  strictEqual(hasWriteback(fault, gprChannel("al")), true);
  strictEqual(hasWriteback(fault, gprChannel("eax")), false);
});

test("destructive alias flushes require a restorable boundary", () => {
  const { pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("al"), i32(1));
  pending.read(gprChannel("ax"));

  throws(() => pending.flushesForPath("fault"), /unrestorable/);

  pending.beginInstruction();
  doesNotThrow(() => pending.flushesForPath("fault"));
});

test("a cached boundary read makes a destructive flush restorable", () => {
  const { dynamicIndex, pending } = createHarness();

  pending.beginInstruction();
  pending.read(gprChannel("esp"));
  pending.write(gprChannel("esp"), i32(0x44));
  pending.readDynamicGpr(dynamicIndex, 32);

  doesNotThrow(() => pending.flushesForPath("fault"));
});

test("dynamic GPR reads publish GPR state without disturbing other channels", () => {
  const { dynamicIndex, pending } = createHarness();

  pending.write(gprChannel("eax"), i32(0x77));
  pending.write(flagStateFields.concrete.ID, i32(1));

  pending.readDynamicGpr(dynamicIndex, 32);

  strictEqual(pending.isDirty(gprChannel("eax")), false);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);
});

test("dynamic GPR writes invalidate tracked GPRs without disturbing other channels", () => {
  const { dynamicIndex, pending } = createHarness();

  pending.write(gprChannel("eax"), i32(0x77));
  pending.write(coreStateFields.eip, i32(0x1000));

  pending.writeDynamicGpr(dynamicIndex, 8, i32(0x22));

  strictEqual(pending.has(gprChannel("eax")), false);
  strictEqual(pending.has(coreStateFields.eip), true);
});

test("dynamic GPR barriers make new instruction writes unrestorable", () => {
  const dynamicWrite = createHarness();

  dynamicWrite.pending.beginInstruction();
  dynamicWrite.pending.writeDynamicGpr(dynamicWrite.dynamicIndex, 32, i32(1));
  throws(() => dynamicWrite.pending.flushesForPath("fault"), /unrestorable/);

  const dynamicRead = createHarness();

  dynamicRead.pending.beginInstruction();
  dynamicRead.pending.write(gprChannel("ebx"), i32(1));
  dynamicRead.pending.readDynamicGpr(dynamicRead.dynamicIndex, 32);
  throws(() => dynamicRead.pending.flushesForPath("fault"), /unrestorable/);
});
