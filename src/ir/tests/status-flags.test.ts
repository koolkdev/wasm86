import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { Action, EdgeFlushAction } from "#ir/actions.js";
import { PendingState } from "#ir/pending/state.js";
import { StatusFlags } from "#ir/status-flags.js";
import { lazyFlagsKindChannel } from "#ir/slots.js";
import { ValueTable, type ValueId } from "#ir/values.js";
import { isX86StatusFlag, x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { assertOnlyLazyRecord } from "./lazy-flags.js";

type Harness = Readonly<{
  values: ValueTable;
  actions: Action[];
  pending: PendingState;
  flags: StatusFlags;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const actions: Action[] = [];
  const pending = new PendingState(values, (action) => actions.push(action));

  return { values, actions, pending, flags: new StatusFlags(values, pending) };
}

function flagFlushEntries(actions: readonly EdgeFlushAction[]): ReadonlyArray<Readonly<{ flag: X86StatusFlag; value: ValueId }>> {
  return actions.flatMap((action) =>
    action.slot.kind === "flag" && isX86StatusFlag(action.slot.flag)
      ? [{ flag: action.slot.flag, value: action.value }]
      : []
  );
}

function flagFlushValue(actions: readonly EdgeFlushAction[], flag: X86StatusFlag): ValueId | undefined {
  return flagFlushEntries(actions).find((entry) => entry.flag === flag)?.value;
}

function assertFullExplicitFlush(actions: readonly EdgeFlushAction[], values: ValueTable): void {
  deepStrictEqual(flagFlushEntries(actions).map((entry) => entry.flag), x86StatusFlags);
  strictEqual(actions.find((action) => action.slot === lazyFlagsKindChannel)?.value, values.const(0));
  strictEqual(actions.length, x86StatusFlags.length + 1);
}

test("new status flags start with no dirty pending entries", () => {
  const { pending } = createHarness();

  deepStrictEqual(pending.flushesForEdge("fault"), []);
  deepStrictEqual(pending.flushesForEdge("completed"), []);
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
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  const completedFlushes = pending.flushesForEdge("completed");

  assertOnlyLazyRecord(completedFlushes, values, { kind: "SUB", width: 32, left, right });
  strictEqual(
    flagValue(flags, "ZF"),
    values.compare("eq", result, values.const(0))
  );
});

test("an add source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0xffff_ffff);
  const right = values.const(1);
  const result = values.binary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 32, left, right, result });

  assertOnlyLazyRecord(pending.flushesForEdge("completed"), values, { kind: "ADD", width: 32, left, right });
  strictEqual(
    flagValue(flags, "CF"),
    values.compare("lt_u", values.project(32, result), values.project(32, left))
  );
});

test("sub lazy commits project narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 16, left, right, result });

  assertOnlyLazyRecord(pending.flushesForEdge("completed"), values, { kind: "SUB", width: 16, left, right });
});

test("add lazy commits project narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 8, left, right, result });

  assertOnlyLazyRecord(pending.flushesForEdge("completed"), values, { kind: "ADD", width: 8, left, right });
});

test("condition uses the current sub source directly", () => {
  const { values, actions, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  strictEqual(flags.condition("E"), values.compare("eq", left, right));
  strictEqual(flags.condition("B"), values.compare("lt_u", left, right));
  strictEqual(flags.condition("L"), values.compare("lt_s", left, right));
  deepStrictEqual(actions, []);
});

test("condition falls back to live flag backings after a direct flag write", () => {
  const { values, actions, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const zero = values.const(0);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", zero);

  strictEqual(flags.condition("E"), zero);
  strictEqual(
    flags.condition("NE"),
    values.compare("eq", zero, zero)
  );
  deepStrictEqual(actions, []);
});

test("mixed pending and input condition combines pending values with helper calls", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.const(1);

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
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const source = { kind: "sub", width: 32, left, right, result } as const;

  flags.writeStatusFlagsSource(source);
  pending.beginInstruction();
  flags.writeFlag("ZF", values.const(0));

  const faultFlushes = pending.flushesForEdge("fault");
  const completedFlushes = pending.flushesForEdge("completed");

  assertOnlyLazyRecord(faultFlushes, values, { kind: "SUB", width: 32, left, right });
  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(
    flagFlushValue(completedFlushes, "ZF"),
    values.const(0)
  );
});

test("a logic source commits a lazy result record and resolves current values", () => {
  const { values, pending, flags } = createHarness();
  const result = values.const(0x80);
  const projected = values.project(8, result);
  const zero = values.const(0);

  flags.writeStatusFlagsSource({ kind: "logic", width: 8, result });

  strictEqual(flagValue(flags, "CF"), zero);
  strictEqual(flagValue(flags, "AF"), zero);
  strictEqual(flagValue(flags, "OF"), zero);
  strictEqual(flagValue(flags, "ZF"), values.compare("eq", projected, zero));
  strictEqual(flagValue(flags, "SF"), values.binary("shr_u", projected, values.const(7)));

  const completedFlushes = pending.flushesForEdge("completed");

  assertOnlyLazyRecord(completedFlushes, values, { kind: "LOGIC_RESULT", width: 8, result });
});

test("direct status flag writes set explicit pending values", () => {
  const { values, pending, flags } = createHarness();
  const explicit = Object.fromEntries(
    x86StatusFlags.map((flag, index) => [flag, values.const(index & 1)])
  ) as Record<(typeof x86StatusFlags)[number], number>;

  for (const flag of x86StatusFlags) {
    flags.writeFlag(flag, explicit[flag]);
  }

  for (const flag of x86StatusFlags) {
    strictEqual(flagValue(flags, flag), explicit[flag]);
  }

  const completedFlushes = pending.flushesForEdge("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, explicit.ZF);
});

test("writeFlag updates one status flag while preserving other pending values", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const zf = values.const(1);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", zf);

  strictEqual(flagValue(flags, "CF"), values.compare("lt_u", left, right));
  strictEqual(flagValue(flags, "ZF"), zf);

  const completedFlushes = pending.flushesForEdge("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, zf);
});

test("a direct flag write from input state flushes a full explicit image", () => {
  const { values, actions, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.writeFlag("ZF", zf);

  const completedFlushes = pending.flushesForEdge("completed");

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(flagFlushValue(completedFlushes, "ZF"), zf);

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    const value = flagFlushValue(completedFlushes, flag);

    ok(value !== undefined, `expected ${flag} to be flushed`);
    deepStrictEqual(values.node(value), { kind: "helperCall", helper: { kind: "lazyFlag", flag } });
  }
  deepStrictEqual(actions, []);
});

function flagValue(flags: StatusFlags, flag: X86StatusFlag): ValueId {
  return flags.readFlag(flag);
}
