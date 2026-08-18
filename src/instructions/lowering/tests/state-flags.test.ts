import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { covers } from "#compiler/function/storage.js";
import { RegionBuilder } from "#compiler/function/builder/region.js";
import {
  integer,
  i32,
  u8,
  u16,
  type AnyNarrowInteger,
  type BitValue
} from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { flagStateFields, type FlagStateField } from "#core/flags/layout.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { OperandWidth } from "#core/types.js";
import { InstructionState } from "../state/state.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { cpuStateAccess, cpuStatusFlagResolvers } from "#test/support/execution-model.js";
import type { StateWriteback } from "../state/writeback.js";
import { stateEffect } from "./state-operations.js";

type Harness = Readonly<{
  region: RegionBuilder;
  pending: Readonly<{
    flushesForPath(path: "fault" | "completed"): readonly StateWriteback[];
  }>;
  flags: TestStatusFlags;
}>;

type TestStatusFlags = Readonly<{
  write(flag: X86StatusFlag, value: BitValue): void;
  writeSource<const Width extends OperandWidth>(source: SimpleFlagSource<Width>): void;
}>;

function createHarness(): Harness {
  const values = new ValueResolver();
  const body = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const access = state.forRegion(body);
  const context = { region: body, access };

  return {
    region: body,
    pending: {
      flushesForPath: (path) => state.flushesForPath(access, path)
    },
    flags: {
      write: (flag, value) => state.statusFlags.write(context, flag, value),
      writeSource: (source) => state.statusFlags.writeSource(context, source)
    }
  };
}

function writesFor(writebacks: readonly StateWriteback[], field: FlagStateField): StateWriteback[] {
  return writebacks.filter((writeback) => writesField(writeback, field));
}

function writesField(writeback: StateWriteback, field: FlagStateField): boolean {
  const effect = stateEffect(field);

  return covers(effect, writeback.effect) && covers(writeback.effect, effect);
}

function concreteFlagWriteValue(
  writes: readonly StateWriteback[],
  flag: X86StatusFlag
): AnyNarrowInteger | undefined {
  const matching = writesFor(writes, flagStateFields.concrete[flag]);

  return matching.length === 1 ? matching[0]!.value : undefined;
}

function assertFullExplicitFlush(region: RegionBuilder, writes: readonly StateWriteback[]): void {
  for (const flag of x86StatusFlags) {
    strictEqual(
      writesFor(writes, flagStateFields.concrete[flag]).length,
      1,
      `${flag} is committed explicitly`
    );
  }

  const kindWrites = writesFor(writes, flagStateFields.lazyKind);

  strictEqual(kindWrites.length, 1);
  strictEqual(
    region.constValue(kindWrites[0]!.value),
    0,
    "explicit flags clear the lazy source kind"
  );
}

test("arm-local resolution preserves current and fault-boundary flag images", () => {
  const values = new ValueResolver();
  const root = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const rootAccess = state.forRegion(root);
  const rootContext = { region: root, access: rootAccess };
  const beforeLeft = i32(10);
  const beforeRight = i32(3);
  const afterLeft = i32(7);
  const afterRight = i32(5);

  state.statusFlags.writeSource(rootContext, {
    kind: "sub",
    width: 32,
    left: beforeLeft,
    right: beforeRight,
    result: beforeLeft.sub(beforeRight)
  });
  state.beginInstructionBoundary();
  state.statusFlags.writeSource(rootContext, {
    kind: "sub",
    width: 32,
    left: afterLeft,
    right: afterRight,
    result: afterLeft.sub(afterRight)
  });
  state.statusFlags.resetToInputs();

  const arm = root.child();
  const armAccess = state.forRegion(arm);

  state.enterScope(() => {
    state.statusFlags.read({ region: arm, access: armAccess }, "ZF");
  });

  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(rootAccess, "completed"), root), {
    kindByte: 9,
    a: 7,
    b: 5
  });
  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(rootAccess, "fault"), root), {
    kindByte: 9,
    a: 10,
    b: 3
  });
});

test("sub, add, and logic sources commit their compact lazy records", () => {
  {
    const { region, pending, flags } = createHarness();
    const left = i32(0x1234_5678);
    const right = i32(0x1111_1111);

    flags.writeSource({
      kind: "sub",
      width: 32,
      left,
      right,
      result: left.sub(right)
    });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), region), {
      kindByte: 9,
      a: 0x1234_5678,
      b: 0x1111_1111
    });
  }

  {
    const { region, pending, flags } = createHarness();
    const left = u8(0x1f0);
    const right = u8(0x130);

    flags.writeSource({
      kind: "add",
      width: 8,
      left,
      right,
      result: left.add(right)
    });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), region), {
      kindByte: 2,
      a: 0xf0,
      b: 0x30
    });
  }

  {
    const { region, pending, flags } = createHarness();
    const result = u16(0x1234_8000);

    flags.writeSource({ kind: "logic", width: 16, result });
    deepStrictEqual(lazyRecordSnapshot(pending.flushesForPath("completed"), region), {
      kindByte: 7,
      a: 0x8000
    });
  }
});

test("a direct flag write commits one explicit architectural image", () => {
  const { region, pending, flags } = createHarness();
  const zf = integer(1, 1);

  flags.write("ZF", zf);
  const completed = pending.flushesForPath("completed");

  assertFullExplicitFlush(region, completed);
  const writtenZf = concreteFlagWriteValue(completed, "ZF");

  ok(writtenZf !== undefined, "ZF was not committed");
  strictEqual(region.constValue(writtenZf), 1);
});

test("fault and completed paths retain different flag images", () => {
  const values = new ValueResolver();
  const body = new RegionBuilder(values);
  const state = new InstructionState(cpuStateAccess, cpuStatusFlagResolvers, instructionCountField);
  const access = state.forRegion(body);
  const context = { region: body, access };
  const left = i32(7);
  const right = i32(3);

  state.statusFlags.writeSource(context, {
    kind: "sub",
    width: 32,
    left,
    right,
    result: left.sub(right)
  });
  state.beginInstructionBoundary();
  state.statusFlags.write(context, "ZF", integer(1, 1));

  deepStrictEqual(lazyRecordSnapshot(state.flushesForPath(access, "fault"), body), {
    kindByte: 9,
    a: 7,
    b: 3
  });

  const completed = state.flushesForPath(access, "completed");

  assertFullExplicitFlush(body, completed);
  strictEqual(body.constValue(concreteFlagWriteValue(completed, "ZF")!), 1);
});

type LazyRecordSnapshot = Readonly<{
  kindByte: number;
  a: number;
  b?: number;
}>;

function lazyRecordSnapshot(
  writes: readonly StateWriteback[],
  region: RegionBuilder
): LazyRecordSnapshot {
  const kindByte = constantStateFieldWrite(writes, region, flagStateFields.lazyKind);
  const a = constantStateFieldWrite(writes, region, flagStateFields.lazyA);
  const bWrite = writes.find((write) => writesField(write, flagStateFields.lazyB));

  if (bWrite === undefined) {
    return { kindByte, a };
  }

  const b = region.constValue(bWrite.value);

  ok(b !== undefined, "lazy B must be a literal in this fixture");
  return { kindByte, a, b };
}

function constantStateFieldWrite(
  writes: readonly StateWriteback[],
  region: RegionBuilder,
  field: FlagStateField
): number {
  const [write] = writesFor(writes, field);

  ok(write !== undefined, `${field.id} was not committed`);
  const value = region.constValue(write.value);

  ok(value !== undefined, `${field.id} must be a literal in this fixture`);
  return value;
}
