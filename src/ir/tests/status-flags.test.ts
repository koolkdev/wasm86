import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { Action, StateWriteAction } from "#ir/actions.js";
import { PendingState } from "#ir/pending/state.js";
import { StatusFlags } from "#ir/status-flags.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import { ValueTable, type ValueId } from "#ir/values.js";
import type { ConditionCode } from "#x86/conditions.js";
import { simpleFlagSourceConditionOperators } from "#x86/flag-sources.js";
import { isX86StatusFlag, x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { assertOnlyLazyRecord } from "./lazy-flags.js";
import { resolveFlag } from "./storage-op-helpers.js";

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

  return { values, actions, pending, flags: new StatusFlags(values, pending, (action) => actions.push(action)) };
}

function flagFlushEntries(actions: readonly StateWriteAction[]): ReadonlyArray<Readonly<{ flag: X86StatusFlag; value: ValueId }>> {
  return actions.flatMap((action) =>
    action.op.slot.kind === "flag" && isX86StatusFlag(action.op.slot.flag)
      ? [{ flag: action.op.slot.flag, value: action.op.value }]
      : []
  );
}

function flagFlushValue(actions: readonly StateWriteAction[], flag: X86StatusFlag): ValueId | undefined {
  return flagFlushEntries(actions).find((entry) => entry.flag === flag)?.value;
}

function assertFullExplicitFlush(actions: readonly StateWriteAction[], values: ValueTable): void {
  deepStrictEqual(flagFlushEntries(actions).map((entry) => entry.flag), x86StatusFlags);
  strictEqual(actions.find((action) => action.op.slot === lazyFlagsKindChannel)?.op.value, values.const(0));
  strictEqual(actions.length, x86StatusFlags.length + 1);
}

function resolveOutput(actions: readonly Action[], flag: X86StatusFlag): ValueId | undefined {
  const action = actions.find(
    (action): action is Action & Readonly<{ kind: "op"; output: ValueId }> =>
      action.kind === "op" &&
      action.op.kind === "cpu.resolveFlag" &&
      action.op.flag === flag &&
      action.output !== undefined
  );

  return action?.output;
}

function switchActions(actions: readonly Action[]): Extract<Action, { kind: "switch" }>[] {
  return actions.filter((action): action is Extract<Action, { kind: "switch" }> => action.kind === "switch");
}

test("new status flags start with no dirty pending entries", () => {
  const { pending } = createHarness();

  deepStrictEqual(pending.flushesForPath("fault"), []);
  deepStrictEqual(pending.flushesForPath("completed"), []);
});

test("input status flags read through scheduled resolve ops", () => {
  const { values, actions, flags } = createHarness();
  const first = flags.readFlag("ZF");
  const second = flags.readFlag("ZF");

  strictEqual(first, second);
  deepStrictEqual(actions, [resolveFlag(first, "ZF")]);
  deepStrictEqual(values.node(first), { kind: "actionOutput" });
});

test("writing the current input status flag value is a no-op", () => {
  const { pending, flags } = createHarness();
  const zf = flags.readFlag("ZF");

  flags.writeFlag("ZF", zf);

  deepStrictEqual(pending.flushesForPath("completed"), []);
});

test("a sub source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  const completedFlushes = pending.flushesForPath("completed");

  assertOnlyLazyRecord(completedFlushes, values, { kind: "SUB", width: 32, left, right });
  strictEqual(
    flagValue(flags, "ZF"),
    values.compare("eq", result, values.const(0))
  );
});

test("writing the current source status flag value preserves the lazy source", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", flags.readFlag("ZF"));

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "SUB", width: 32, left, right });
});

test("an add source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0xffff_ffff);
  const right = values.const(1);
  const result = values.binary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 32, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "ADD", width: 32, left, right });
  strictEqual(
    flagValue(flags, "CF"),
    values.compare("lt_u", values.truncate(32, result), values.truncate(32, left))
  );
});

test("sub lazy commits truncated narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 16, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "SUB", width: 16, left, right });
});

test("add lazy commits truncated narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("add", left, right);

  flags.writeStatusFlagsSource({ kind: "add", width: 8, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "ADD", width: 8, left, right });
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

test("input-backed compare-family condition builds a lazy SUB switch", () => {
  const { values, actions, flags } = createHarness();
  const condition = flags.condition("BE");
  const switchAction = switchActions(actions)[0];

  ok(switchAction !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchAction.output);
  strictEqual(actions.length, 2);
  deepStrictEqual(actions[0], {
    kind: "op",
    output: switchAction.selector,
    op: { kind: "state.read", slot: lazyFlagsKindChannel }
  });
  deepStrictEqual(
    switchAction.cases.map((entry) => entry.match),
    [8, 16, 32].map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, width as 8 | 16 | 32))
  );

  for (const switchCase of switchAction.cases) {
    deepStrictEqual(switchCase.body.actions.map((action) => action.kind === "op" ? action.op : undefined), [
      { kind: "state.read", slot: lazyFlagsAChannel },
      { kind: "state.read", slot: lazyFlagsBChannel }
    ]);

    const result = values.node(switchCase.body.result!);

    ok(result.kind === "compare", "expected direct arm compare");
    strictEqual(result.operator, "le_u");
  }

  deepStrictEqual(
    switchAction.defaultBody.actions.map((action) => action.kind === "op" ? action.op : undefined),
    [
      { kind: "cpu.resolveFlag", flag: "CF" },
      { kind: "cpu.resolveFlag", flag: "ZF" }
    ]
  );

  const fallback = values.node(switchAction.defaultBody.result!);

  ok(fallback.kind === "binary", "expected fallback CF | ZF expression");
  strictEqual(fallback.operator, "or");
});

test("input-backed equality condition builds lazy cases from the shared operator table", () => {
  const { actions, flags } = createHarness();
  const condition = flags.condition("E");
  const switchAction = switchActions(actions)[0];

  ok(switchAction !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchAction.output);
  deepStrictEqual(switchAction.cases.map((entry) => entry.match), expectedLazyConditionCases("E"));
  deepStrictEqual(
    switchAction.cases.map((entry) => entry.body.actions.map((action) => {
      ok(action.kind === "op" && action.op.kind === "state.read", "expected arm-local state read");
      return action.op.slot;
    })),
    [
      [lazyFlagsAChannel, lazyFlagsBChannel],
      [lazyFlagsAChannel],
      [lazyFlagsAChannel, lazyFlagsBChannel],
      [lazyFlagsAChannel],
      [lazyFlagsAChannel, lazyFlagsBChannel],
      [lazyFlagsAChannel]
    ]
  );
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

test("mixed pending and input condition combines pending values with resolve outputs", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.const(1);

  flags.writeFlag("ZF", zf);

  const condition = flags.condition("BE");
  const node = values.node(condition);

  ok(node.kind === "binary", "expected BE condition to lower to CF | ZF");
  strictEqual(node.operator, "or");
  deepStrictEqual(values.node(node.a), { kind: "actionOutput" });
  strictEqual(resolveOutput(actions, "CF"), node.a);
  strictEqual(node.b, zf);
  strictEqual(switchActions(actions).length, 0);
});

test("non-compare-family input condition stays on the helper-backed expression path", () => {
  const { actions, flags } = createHarness();
  const condition = flags.condition("S");

  deepStrictEqual(actions, [resolveFlag(condition, "SF")]);
  strictEqual(switchActions(actions).length, 0);
});

test("fault edge preserves a clean sub source while direct flag writes update completed fallback values", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const source = { kind: "sub", width: 32, left, right, result } as const;

  flags.writeStatusFlagsSource(source);
  pending.beginInstruction();
  flags.writeFlag("ZF", values.const(1));

  const faultFlushes = pending.flushesForPath("fault");
  const completedFlushes = pending.flushesForPath("completed");

  assertOnlyLazyRecord(faultFlushes, values, { kind: "SUB", width: 32, left, right });
  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(
    flagFlushValue(completedFlushes, "ZF"),
    values.const(1)
  );
});

test("a logic source commits a lazy result record and resolves current values", () => {
  const { values, pending, flags } = createHarness();
  const result = values.const(0x80);
  const truncated = values.truncate(8, result);
  const zero = values.const(0);

  flags.writeStatusFlagsSource({ kind: "logic", width: 8, result });

  strictEqual(flagValue(flags, "CF"), zero);
  strictEqual(flagValue(flags, "AF"), zero);
  strictEqual(flagValue(flags, "OF"), zero);
  strictEqual(flagValue(flags, "ZF"), values.compare("eq", truncated, zero));
  strictEqual(flagValue(flags, "SF"), values.binary("shr_u", truncated, values.const(7)));

  const completedFlushes = pending.flushesForPath("completed");

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

  const completedFlushes = pending.flushesForPath("completed");
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

  const completedFlushes = pending.flushesForPath("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, zf);
});

test("a direct flag write from input state flushes a full explicit image from resolve ops", () => {
  const { values, actions, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.writeFlag("ZF", zf);

  const completedFlushes = pending.flushesForPath("completed");

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(flagFlushValue(completedFlushes, "ZF"), zf);

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    const value = flagFlushValue(completedFlushes, flag);

    ok(value !== undefined, `expected ${flag} to be flushed`);
    deepStrictEqual(values.node(value), { kind: "actionOutput" });
    strictEqual(resolveOutput(actions, flag), value);
  }
  deepStrictEqual(
    actions,
    x86StatusFlags.map((flag) => resolveFlag(resolveOutput(actions, flag)!, flag))
  );
});

function flagValue(flags: StatusFlags, flag: X86StatusFlag): ValueId {
  return flags.readFlag(flag);
}

function expectedLazyConditionCases(cc: ConditionCode): readonly number[] {
  return ([8, 16, 32] as const).flatMap((width) => [
    ...expectedLazyConditionCase(LAZY_FLAGS_KIND.ADD, width, simpleFlagSourceConditionOperators.add[cc] !== undefined),
    ...expectedLazyConditionCase(LAZY_FLAGS_KIND.SUB, width, simpleFlagSourceConditionOperators.sub[cc] !== undefined),
    ...expectedLazyConditionCase(
      LAZY_FLAGS_KIND.LOGIC_RESULT,
      width,
      simpleFlagSourceConditionOperators.logic[cc] !== undefined
    )
  ]);
}

function expectedLazyConditionCase(
  kind: (typeof LAZY_FLAGS_KIND)[keyof typeof LAZY_FLAGS_KIND],
  width: 8 | 16 | 32,
  supported: boolean
): readonly number[] {
  return supported ? [lazyFlagsKindByte(kind, width)] : [];
}
