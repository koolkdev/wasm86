import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { covers } from "#compiler/ir/effects.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ResourceWriteArgs } from "#compiler/ir/operations/resource.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { flagStateFields, type FlagStateField } from "#core/flags/layout.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import { InstructionState } from "../state/state.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { cpuStateAccess, cpuStatusFlagResolvers } from "#test/support/execution-model.js";
import { stateEffect } from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  pending: Readonly<{
    flushesForPath(path: "fault" | "completed"): readonly ResourceWriteArgs[];
  }>;
  flags: TestStatusFlags;
}>;

type TestStatusFlags = Readonly<{
  write(flag: X86StatusFlag, value: ValueId): void;
  writeSource(source: SimpleFlagSource): void;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const access = state.bind(body);
  const context = { region: body, access };

  return {
    values,
    pending: {
      flushesForPath: (path) => state.flushesForPath(access, path)
    },
    flags: {
      write: (flag, value) => state.statusFlags.write(context, flag, value),
      writeSource: (source) => state.statusFlags.writeSource(context, source)
    }
  };
}

function writesFor(
  values: ValueTable,
  writebacks: readonly ResourceWriteArgs[],
  field: FlagStateField
): ResourceWriteArgs[] {
  return writebacks.filter((writeback) => writesField(values, writeback, field));
}

function writesField(
  values: ValueTable,
  writeback: ResourceWriteArgs,
  field: FlagStateField
): boolean {
  const effect = stateEffect(values, field);

  return (
    covers(effect, writeback.destination.effect) && covers(writeback.destination.effect, effect)
  );
}

function concreteFlagWriteValue(
  values: ValueTable,
  writes: readonly ResourceWriteArgs[],
  flag: X86StatusFlag
): ValueId | undefined {
  const matching = writesFor(values, writes, flagStateFields.concrete[flag]);

  return matching.length === 1 ? matching[0]!.value : undefined;
}

function assertFullExplicitFlush(values: ValueTable, writes: readonly ResourceWriteArgs[]): void {
  for (const flag of x86StatusFlags) {
    strictEqual(
      writesFor(values, writes, flagStateFields.concrete[flag]).length,
      1,
      `${flag} is committed explicitly`
    );
  }

  const kindWrites = writesFor(values, writes, flagStateFields.lazyKind);

  strictEqual(kindWrites.length, 1);
  strictEqual(
    values.constValue(kindWrites[0]!.value),
    0,
    "explicit flags clear the lazy source kind"
  );
}

test("arm-local resolution preserves current and fault-boundary flag images", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const rootAccess = state.bind(root);
  const rootContext = { region: root, access: rootAccess };
  const beforeLeft = values.const(10);
  const beforeRight = values.const(3);
  const afterLeft = values.const(7);
  const afterRight = values.const(5);

  state.statusFlags.writeSource(rootContext, {
    kind: "sub",
    width: 32,
    left: beforeLeft,
    right: beforeRight,
    result: values.binary("sub", beforeLeft, beforeRight)
  });
  state.beginInstructionBoundary();
  state.statusFlags.writeSource(rootContext, {
    kind: "sub",
    width: 32,
    left: afterLeft,
    right: afterRight,
    result: values.binary("sub", afterLeft, afterRight)
  });
  state.statusFlags.resetToInputs();

  const arm = root.child();
  const armAccess = state.bind(arm);

  state.enterScope(() => {
    state.statusFlags.read({ region: arm, access: armAccess }, "ZF");
  });

  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(rootAccess, "completed"), values), {
    kindByte: 9,
    a: 7,
    b: 5
  });
  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(rootAccess, "fault"), values), {
    kindByte: 9,
    a: 10,
    b: 3
  });
});

test("sub, add, and logic sources commit their compact lazy records", () => {
  {
    const { values, pending, flags } = createHarness();
    const left = values.const(0x1234_5678);
    const right = values.const(0x1111_1111);

    flags.writeSource({
      kind: "sub",
      width: 32,
      left,
      right,
      result: values.binary("sub", left, right)
    });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), values), {
      kindByte: 9,
      a: 0x1234_5678,
      b: 0x1111_1111
    });
  }

  {
    const { values, pending, flags } = createHarness();
    const left = values.const(0x1f0);
    const right = values.const(0x130);

    flags.writeSource({
      kind: "add",
      width: 8,
      left,
      right,
      result: values.binary("add", left, right)
    });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), values), {
      kindByte: 2,
      a: 0xf0,
      b: 0x30
    });
  }

  {
    const { values, pending, flags } = createHarness();
    const result = values.const(0x1234_8000);

    flags.writeSource({ kind: "logic", width: 16, result });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), values), {
      kindByte: 7,
      a: 0x8000
    });
  }
});

test("a direct flag write commits one explicit architectural image", () => {
  const { values, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);
  const completed = pending.flushesForPath("completed");

  assertFullExplicitFlush(values, completed);
  const writtenZf = concreteFlagWriteValue(values, completed, "ZF");

  ok(writtenZf !== undefined, "ZF was not committed");
  strictEqual(values.constValue(writtenZf), 1);
});

test("fault and completed paths retain different flag images", () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const access = state.bind(body);
  const context = { region: body, access };
  const left = values.const(7);
  const right = values.const(3);

  state.statusFlags.writeSource(context, {
    kind: "sub",
    width: 32,
    left,
    right,
    result: values.binary("sub", left, right)
  });
  state.beginInstructionBoundary();
  state.statusFlags.write(context, "ZF", values.const(1));

  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(access, "fault"), values), {
    kindByte: 9,
    a: 7,
    b: 3
  });

  const completed = state.flushesForPath(access, "completed");

  assertFullExplicitFlush(values, completed);
  strictEqual(values.constValue(concreteFlagWriteValue(values, completed, "ZF")!), 1);
});

type LazyRecordSnapshot = Readonly<{
  kindByte: number;
  a: number;
  b?: number;
}>;

function lazyRecordSnapshot(
  writes: readonly ResourceWriteArgs[],
  values: ValueTable
): LazyRecordSnapshot {
  const kindByte = constantStateFieldWrite(writes, values, flagStateFields.lazyKind);
  const a = constantStateFieldWrite(writes, values, flagStateFields.lazyA);
  const bWrite = writes.find((write) => writesField(values, write, flagStateFields.lazyB));

  if (bWrite === undefined) {
    return { kindByte, a };
  }

  const b = values.constValue(bWrite.value);

  ok(b !== undefined, "lazy B must be a literal in this fixture");
  return { kindByte, a, b };
}

function constantStateFieldWrite(
  writes: readonly ResourceWriteArgs[],
  values: ValueTable,
  field: FlagStateField
): number {
  const [write] = writesFor(values, writes, field);

  ok(write !== undefined, `${field.id} was not committed`);
  const value = values.constValue(write.value);

  ok(value !== undefined, `${field.id} must be a literal in this fixture`);
  return value;
}
