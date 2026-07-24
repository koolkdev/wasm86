import {
  doesNotThrow,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { covers } from "#compiler/ir/effects.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ResourceWriteArgs } from "#compiler/ir/operations/resource.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { flagStateFields } from "#core/flags/layout.js";
import { StateAccess } from "#core/state/access.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { OperandWidth } from "#core/types.js";
import { cpuState } from "#test/support/execution-model.js";
import { StateFieldTracker } from "../state/field-tracker.js";
import { GprState, type GprReadOptions } from "../state/gpr.js";
import type { InstructionStateChannel } from "../state/channels.js";
import type { StatePathKind } from "../state/pending-buffer.js";
import { stateEffect } from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  pending: PendingHarness;
}>;

type PendingHarness = Readonly<{
  read(channel: InstructionStateChannel, options?: GprReadOptions): ValueId;
  write(channel: InstructionStateChannel, value: ValueId): void;
  has(channel: InstructionStateChannel): boolean;
  isDirty(channel: InstructionStateChannel): boolean;
  beginInstruction(): void;
  flushesForPath(path: StatePathKind): readonly ResourceWriteArgs[];
  readDynamicGpr(
    index: ValueId,
    width: OperandWidth,
    options?: GprReadOptions
  ): ValueId;
  writeDynamicGpr(index: ValueId, width: OperandWidth, value: ValueId): void;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const stateAccess = new StateAccess(cpuState);
  const access = stateAccess.bind(body);
  const fields = new StateFieldTracker(stateAccess);
  const gpr = new GprState(stateAccess);

  return {
    values,
    pending: {
      read: (channel, options) => channel.kind === "gpr"
        ? gpr.readChannel(access, channel, options)
        : fields.read(access, channel),
      write: (channel, value) => {
        if (channel.kind === "gpr") {
          gpr.writeChannel(access, channel, value);
          return;
        }

        fields.write(channel, value);
      },
      has: (channel) =>
        channel.kind === "gpr" ? gpr.has(channel) : fields.has(channel),
      isDirty: (channel) => channel.kind === "gpr"
        ? gpr.isChannelDirty(channel)
        : fields.isDirty(channel),
      beginInstruction: () => {
        gpr.beginInstruction();
        fields.beginInstruction();
      },
      flushesForPath: (path) => [
        ...gpr.flushesForPath(access, path),
        ...fields.flushesForPath(access, path)
      ],
      readDynamicGpr: (index, width, options) =>
        gpr.readDynamic(access, index, width, options),
      writeDynamicGpr: (index, width, value) =>
        gpr.writeDynamic(access, index, width, value)
    }
  };
}

function hasWriteback(
  values: ValueTable,
  writebacks: readonly ResourceWriteArgs[],
  channel: InstructionStateChannel
): boolean {
  const effect = stateEffect(values, channel);

  return writebacks.some((writeback) =>
    covers(effect, writeback.destination.effect) &&
    covers(writeback.destination.effect, effect)
  );
}

test("writing an input value back cancels pending state", () => {
  for (const channel of [
    gprChannel("eax"),
    flagStateFields.concrete.ZF
  ] as const) {
    const { values, pending } = createHarness();
    const input = pending.read(channel);

    pending.write(channel, values.const(1));
    strictEqual(pending.has(channel), true);

    pending.write(channel, input);
    strictEqual(pending.has(channel), false);
  }
});

test("a covering GPR write replaces narrower pending aliases", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("al"), values.const(0x12));
  pending.write(gprChannel("ah"), values.const(0x34));

  strictEqual(pending.has(gprChannel("al")), true);
  strictEqual(pending.has(gprChannel("ah")), true);

  pending.write(gprChannel("eax"), values.const(0x1234_5678));

  strictEqual(pending.has(gprChannel("al")), false);
  strictEqual(pending.has(gprChannel("ah")), false);
  strictEqual(pending.has(gprChannel("eax")), true);
});

test("an alias read publishes pending GPR bytes without disturbing other state", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("al"), values.const(0x12));
  pending.write(gprChannel("ah"), values.const(0x34));
  pending.write(flagStateFields.concrete.ID, values.const(1));

  strictEqual(pending.isDirty(gprChannel("ax")), true);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);

  pending.read(gprChannel("ax"));

  strictEqual(pending.isDirty(gprChannel("ax")), false);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);
});

test("fault paths restore the instruction boundary rather than current writes", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("eax"), values.const(1));
  pending.write(coreStateFields.eip, values.const(0x1000));
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(2));
  pending.write(gprChannel("ecx"), values.const(3));

  const fault = pending.flushesForPath("fault");
  const completed = pending.flushesForPath("completed");

  strictEqual(hasWriteback(values, fault, gprChannel("eax")), true);
  strictEqual(hasWriteback(values, fault, coreStateFields.eip), true);
  strictEqual(hasWriteback(values, fault, gprChannel("ecx")), false);
  strictEqual(hasWriteback(values, completed, gprChannel("eax")), true);
  strictEqual(hasWriteback(values, completed, coreStateFields.eip), true);
  strictEqual(hasWriteback(values, completed, gprChannel("ecx")), true);
});

test("covering writes preserve a narrower fault-boundary channel", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("al"), values.const(0x12));
  pending.beginInstruction();
  pending.write(gprChannel("eax"), values.const(0x1234_5678));

  const fault = pending.flushesForPath("fault");

  strictEqual(hasWriteback(values, fault, gprChannel("al")), true);
  strictEqual(hasWriteback(values, fault, gprChannel("eax")), false);
});

test("destructive alias flushes require a restorable boundary", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.write(gprChannel("al"), values.const(1));
  pending.read(gprChannel("ax"));

  throws(() => pending.flushesForPath("fault"), /unrestorable/);

  pending.beginInstruction();
  doesNotThrow(() => pending.flushesForPath("fault"));
});

test("a cached boundary read makes a destructive flush restorable", () => {
  const { values, pending } = createHarness();

  pending.beginInstruction();
  pending.read(gprChannel("esp"));
  pending.write(gprChannel("esp"), values.const(0x44));
  pending.readDynamicGpr(values.parameter(0, "i32"), 32);

  doesNotThrow(() => pending.flushesForPath("fault"));
});

test("dynamic GPR reads publish GPR state without disturbing other channels", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("eax"), values.const(0x77));
  pending.write(flagStateFields.concrete.ID, values.const(1));

  pending.readDynamicGpr(values.parameter(0, "i32"), 32);

  strictEqual(pending.isDirty(gprChannel("eax")), false);
  strictEqual(pending.isDirty(flagStateFields.concrete.ID), true);
});

test("dynamic GPR writes invalidate tracked GPRs without disturbing other channels", () => {
  const { values, pending } = createHarness();

  pending.write(gprChannel("eax"), values.const(0x77));
  pending.write(coreStateFields.eip, values.const(0x1000));

  pending.writeDynamicGpr(
    values.parameter(0, "i32"),
    8,
    values.const(0x22)
  );

  strictEqual(pending.has(gprChannel("eax")), false);
  strictEqual(pending.has(coreStateFields.eip), true);
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
