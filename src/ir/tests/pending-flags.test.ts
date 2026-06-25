import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { Action, EdgeFlushAction } from "#ir/actions.js";
import { PendingFlags } from "#ir/pending/flags.js";
import { PendingStateAccess } from "#ir/pending/state-access.js";
import {
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsHeaderChannel,
  type LazyFlagsChannel
} from "#ir/slots.js";
import { ValueTable, type ValueId } from "#ir/values.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { LAZY_FLAGS_KIND, lazyFlagsHeader } from "#ir/lazy-flags.js";

type Harness = Readonly<{
  values: ValueTable;
  actions: Action[];
  flags: PendingFlags;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const actions: Action[] = [];
  const state = new PendingStateAccess(values, (action) => actions.push(action));

  return { values, actions, flags: new PendingFlags(values, state) };
}

function flagFlushEntries(actions: readonly EdgeFlushAction[]): ReadonlyArray<Readonly<{ flag: X86StatusFlag; value: ValueId }>> {
  return actions.flatMap((action) =>
    action.slot.kind === "flag" && (x86StatusFlags as readonly string[]).includes(action.slot.flag)
      ? [{ flag: action.slot.flag as X86StatusFlag, value: action.value }]
      : []
  );
}

function flagFlushValue(actions: readonly EdgeFlushAction[], flag: X86StatusFlag): ValueId | undefined {
  return flagFlushEntries(actions).find((entry) => entry.flag === flag)?.value;
}

function assertFullConcreteFlush(actions: readonly EdgeFlushAction[], values: ValueTable): void {
  deepStrictEqual(flagFlushEntries(actions).map((entry) => entry.flag), x86StatusFlags);
  strictEqual(actions.find((action) => action.slot === lazyFlagsHeaderChannel)?.value, values.internConst(0));
  strictEqual(actions.length, x86StatusFlags.length + 1);
}

function lazyFlushValue(
  actions: readonly EdgeFlushAction[],
  slot: LazyFlagsChannel
): ValueId | undefined {
  return actions.find((action) => action.slot === slot)?.value;
}

function assertLazyCommit(
  actions: readonly EdgeFlushAction[],
  values: ValueTable,
  expected: Readonly<{ kind: "ADD" | "SUB"; width: 8 | 16 | 32; left: ValueId; right: ValueId }>
): void {
  deepStrictEqual(flagFlushEntries(actions), []);
  strictEqual(lazyFlushValue(actions, lazyFlagsAChannel), values.projectTo(expected.width, expected.left));
  strictEqual(lazyFlushValue(actions, lazyFlagsBChannel), values.projectTo(expected.width, expected.right));
  strictEqual(
    lazyFlushValue(actions, lazyFlagsHeaderChannel),
    values.internConst(lazyFlagsHeader(LAZY_FLAGS_KIND[expected.kind], expected.width))
  );
  strictEqual(actions.length, 3);
}

test("new pending flags start with no dirty entries", () => {
  const { flags } = createHarness();

  deepStrictEqual(flags.flushesForEdge("fault"), []);
  deepStrictEqual(flags.flushesForEdge("completed"), []);
});

test("input status flags read through helper calls", () => {
  const { values, actions, flags } = createHarness();
  const first = flags.readFlag("ZF");
  const second = flags.readFlag("ZF");

  notStrictEqual(first, second);
  deepStrictEqual(actions, []);
  deepStrictEqual(values.node(first), { kind: "helperCall", helper: { kind: "lazyFlag", flag: "ZF" } });
  deepStrictEqual(values.node(second), { kind: "helperCall", helper: { kind: "lazyFlag", flag: "ZF" } });
});

test("a sub source commits a lazy runtime record", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  const completedFlushes = flags.flushesForEdge("completed");

  assertLazyCommit(completedFlushes, values, { kind: "SUB", width: 32, left, right });
  strictEqual(
    flagValue(flags, "ZF"),
    values.internCompare("eq", result, values.internConst(0))
  );
});

test("an add source commits a lazy runtime record", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(0xffff_ffff);
  const right = values.internConst(1);
  const result = values.internBinary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 32, left, right, result });

  assertLazyCommit(flags.flushesForEdge("completed"), values, { kind: "ADD", width: 32, left, right });
  strictEqual(
    flagValue(flags, "CF"),
    values.internCompare("lt_u", values.projectTo(32, result), values.projectTo(32, left))
  );
});

test("sub lazy commits project narrow operands", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(0x1234_5678);
  const right = values.internConst(0x8765_4321);
  const result = values.internBinary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 16, left, right, result });

  assertLazyCommit(flags.flushesForEdge("completed"), values, { kind: "SUB", width: 16, left, right });
});

test("add lazy commits project narrow operands", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(0x1234_5678);
  const right = values.internConst(0x8765_4321);
  const result = values.internBinary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 8, left, right, result });

  assertLazyCommit(flags.flushesForEdge("completed"), values, { kind: "ADD", width: 8, left, right });
});

test("condition uses the current sub source directly", () => {
  const { values, actions, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  strictEqual(flags.condition("E"), values.internCompare("eq", left, right));
  strictEqual(flags.condition("B"), values.internCompare("lt_u", left, right));
  strictEqual(flags.condition("L"), values.internCompare("lt_s", left, right));
  deepStrictEqual(actions, []);
});

test("condition falls back to live flag backings after a direct flag write", () => {
  const { values, actions, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);
  const zero = values.internConst(0);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", zero);

  strictEqual(flags.condition("E"), zero);
  strictEqual(
    flags.condition("NE"),
    values.internCompare("eq", zero, zero)
  );
  deepStrictEqual(actions, []);
});

test("mixed pending and input condition combines pending values with helper calls", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.internConst(1);

  flags.writeFlag("ZF", zf);

  const condition = flags.condition("BE");
  const node = values.node(condition);

  ok(node.kind === "binary", "expected BE condition to lower to CF | ZF");
  strictEqual(node.operator, "or");
  deepStrictEqual(values.node(node.a), { kind: "helperCall", helper: { kind: "lazyFlag", flag: "CF" } });
  strictEqual(node.b, zf);
  deepStrictEqual(actions, []);
});

test("fault edge preserves a clean sub source while direct flag writes update completed fallback values", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);
  const source = { kind: "sub", width: 32, left, right, result } as const;

  flags.writeStatusFlagsSource(source);
  flags.beginInstruction();
  flags.writeFlag("ZF", values.internConst(0));

  const faultFlushes = flags.flushesForEdge("fault");
  const completedFlushes = flags.flushesForEdge("completed");

  assertLazyCommit(faultFlushes, values, { kind: "SUB", width: 32, left, right });
  assertFullConcreteFlush(completedFlushes, values);
  strictEqual(
    flagFlushValue(completedFlushes, "ZF"),
    values.internConst(0)
  );
});

test("a logic source materializes fixed, undefined, and derived flag values", () => {
  const { values, flags } = createHarness();
  const result = values.internConst(0x80);
  const projected = values.projectTo(8, result);
  const zero = values.internConst(0);

  flags.writeStatusFlagsSource({ kind: "logic", width: 8, result });

  strictEqual(flagValue(flags, "CF"), zero);
  strictEqual(flagValue(flags, "AF"), zero);
  strictEqual(flagValue(flags, "OF"), zero);
  strictEqual(flagValue(flags, "ZF"), values.internCompare("eq", projected, zero));
  strictEqual(flagValue(flags, "SF"), values.internBinary("shr_u", projected, values.internConst(7)));

  const completedFlushes = flags.flushesForEdge("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullConcreteFlush(completedFlushes, values);
  strictEqual(snapshotValues.find((entry) => entry.flag === "CF")?.value, zero);
  strictEqual(snapshotValues.find((entry) => entry.flag === "AF")?.value, zero);
  strictEqual(snapshotValues.find((entry) => entry.flag === "OF")?.value, zero);
});

test("direct status flag writes set concrete pending values", () => {
  const { values, flags } = createHarness();
  const concrete = Object.fromEntries(
    x86StatusFlags.map((flag, index) => [flag, values.internConst(index & 1)])
  ) as Record<(typeof x86StatusFlags)[number], number>;

  for (const flag of x86StatusFlags) {
    flags.writeFlag(flag, concrete[flag]);
  }

  for (const flag of x86StatusFlags) {
    strictEqual(flagValue(flags, flag), concrete[flag]);
  }

  const completedFlushes = flags.flushesForEdge("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullConcreteFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, concrete.ZF);
});

test("writeFlag updates one status flag while preserving other pending values", () => {
  const { values, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);
  const zf = values.internConst(1);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", zf);

  strictEqual(flagValue(flags, "CF"), values.internCompare("lt_u", left, right));
  strictEqual(flagValue(flags, "ZF"), zf);

  const completedFlushes = flags.flushesForEdge("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullConcreteFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, zf);
});

test("a direct flag write from input state flushes a full concrete image", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.internConst(1);

  flags.writeFlag("ZF", zf);

  const completedFlushes = flags.flushesForEdge("completed");

  assertFullConcreteFlush(completedFlushes, values);
  strictEqual(flagFlushValue(completedFlushes, "ZF"), zf);

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    const value = flagFlushValue(completedFlushes, flag);

    ok(value !== undefined, `expected ${flag} to be flushed`);
    deepStrictEqual(values.node(value), { kind: "helperCall", helper: { kind: "lazyFlag", flag } });
  }
  deepStrictEqual(actions, []);
});

function flagValue(flags: PendingFlags, flag: X86StatusFlag): ValueId {
  return flags.readFlag(flag);
}
