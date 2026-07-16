import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { Action, StateWriteAction } from "#ir/actions.js";
import { BodyBuilder } from "#ir/body-builder.js";
import { State } from "#ir/builder/state/index.js";
import type { StatusFlagState } from "#ir/builder/state/status-flags.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { simpleFlagSourceConditionOperators } from "#core/flags/sources.js";
import { isX86StatusFlag, x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { assertOnlyLazyRecord } from "./lazy-flags.js";
import {
  isStateRead,
  isStatusFlagCall,
  resolvedStatusFlag,
  statusFlagCall,
  type StatusFlagCallAction
} from "./storage-op-helpers.js";

type Harness = Readonly<{
  values: ValueTable;
  actions: Action[];
  pending: Pick<State, "beginInstructionBoundary" | "flushesForPath">;
  flags: StatusFlagState;
}>;

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new BodyBuilder(values);
  const actions = body.build().actions as Action[];
  const state = new State(values, () => body);

  return { values, actions, pending: state, flags: state.statusFlags };
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

function resolverCall(actions: readonly Action[], flag: X86StatusFlag): StatusFlagCallAction | undefined {
  return actions.find(
    (action): action is StatusFlagCallAction =>
      isStatusFlagCall(action) && resolvedStatusFlag(action) === flag
  );
}

function resolvedFlagValue(actions: readonly Action[], flag: X86StatusFlag): ValueId | undefined {
  return resolverCall(actions, flag)?.outputs[0];
}

function resolverCalls(actions: readonly Action[]): readonly StatusFlagCallAction[] {
  return actions.filter(isStatusFlagCall);
}

function stateReadSlots(actions: readonly Action[]) {
  return actions.flatMap((action) =>
    action.kind === "op" && action.op.kind === "state.read"
      ? [action.op.slot]
      : []
  );
}

function assertResolverCall(
  action: StatusFlagCallAction,
  output: ValueId,
  flag: X86StatusFlag,
  args: readonly [ValueId, ValueId, ValueId, ValueId]
): void {
  deepStrictEqual(action, statusFlagCall(output, flag, ...args));
}

function switchActions(actions: readonly Action[]): Extract<Action, { kind: "switch" }>[] {
  return actions.filter((action): action is Extract<Action, { kind: "switch" }> => action.kind === "switch");
}

test("new status flags start with no dirty pending entries", () => {
  const { pending } = createHarness();

  deepStrictEqual(pending.flushesForPath("fault"), []);
  deepStrictEqual(pending.flushesForPath("completed"), []);
});

test("input status flags read through typed resolver calls", () => {
  const { values, actions, flags } = createHarness();
  const first = flags.read("ZF");
  const second = flags.read("ZF");

  strictEqual(first, second);
  deepStrictEqual(stateReadSlots(actions), [
    lazyFlagsKindChannel,
    lazyFlagsAChannel,
    lazyFlagsBChannel,
    flagChannel("ZF")
  ]);
  const call = resolverCall(actions, "ZF");

  ok(call !== undefined, "expected ZF resolver call");
  const inputs = actions.filter(isStateRead).map((action) => action.output) as unknown as readonly [
    ValueId,
    ValueId,
    ValueId,
    ValueId
  ];

  deepStrictEqual(call.arguments.map((argument) => argument.value), inputs);
  assertResolverCall(call, first, "ZF", inputs);
  strictEqual(actions.at(-1), call);
  deepStrictEqual(values.node(first), { kind: "actionOutput", type: "i32" });
});

test("writing the current input status flag value is a no-op", () => {
  const { pending, flags } = createHarness();
  const zf = flags.read("ZF");

  flags.write("ZF", zf);

  deepStrictEqual(pending.flushesForPath("completed"), []);
});

test("a sub source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });

  const completedFlushes = pending.flushesForPath("completed");

  assertOnlyLazyRecord(completedFlushes, values, { kind: "SUB", width: 32, left, right });
  strictEqual(
    flagValue(flags, "ZF"),
    values.compare(32, "eq", result, values.const(0))
  );
});

test("writing the current source status flag value preserves the lazy source", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });
  flags.write("ZF", flags.read("ZF"));

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "SUB", width: 32, left, right });
});

test("an add source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0xffff_ffff);
  const right = values.const(1);
  const result = values.binary("add", left, right);

  flags.writeSource({ kind: "add", width: 32, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "ADD", width: 32, left, right });
  strictEqual(
    flagValue(flags, "CF"),
    values.compare(32, "lt_u", values.truncate(32, result), values.truncate(32, left))
  );
});

test("sub lazy commits truncated narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 16, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "SUB", width: 16, left, right });
});

test("add lazy commits truncated narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("add", left, right);

  flags.writeSource({ kind: "add", width: 8, left, right, result });

  assertOnlyLazyRecord(pending.flushesForPath("completed"), values, { kind: "ADD", width: 8, left, right });
});

test("condition uses the current sub source directly", () => {
  const { values, actions, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });

  strictEqual(flags.condition("E"), values.compare(32, "eq", left, right));
  strictEqual(flags.condition("B"), values.compare(32, "lt_u", left, right));
  strictEqual(flags.condition("L"), values.compare(32, "lt_s", left, right));
  deepStrictEqual(actions, []);
});

test("input-backed compare-family condition builds a lazy SUB switch", () => {
  const { values, actions, flags } = createHarness();
  const condition = flags.condition("BE");
  const switchAction = switchActions(actions)[0];

  ok(switchAction !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchAction.output);
  strictEqual(actions.length, 6);
  const selectorRead = actions[0];

  ok(
    selectorRead?.kind === "op" && selectorRead.op.kind === "state.read",
    "expected lazy-kind state read"
  );
  strictEqual(selectorRead.output, switchAction.selector);
  strictEqual(selectorRead.op.slot, lazyFlagsKindChannel);
  deepStrictEqual(
    switchAction.cases.map((entry) => entry.match),
    [8, 16, 32].map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, width as 8 | 16 | 32))
  );
  const [kindRead, aRead, bRead] = actions.filter(isStateRead);

  ok(kindRead !== undefined && aRead !== undefined && bRead !== undefined, "expected lazy record reads");
  deepStrictEqual([kindRead.op.slot, aRead.op.slot, bRead.op.slot], [
    lazyFlagsKindChannel,
    lazyFlagsAChannel,
    lazyFlagsBChannel
  ]);

  for (const [index, switchCase] of switchAction.cases.entries()) {
    const width = [8, 16, 32][index] as 8 | 16 | 32;

    deepStrictEqual(switchCase.body.actions, []);
    strictEqual(
      switchCase.body.result,
      values.compare(width, "le_u", aRead.output, bRead.output)
    );

    const result = values.node(switchCase.body.result!);

    ok(result.kind === "compare", "expected direct arm compare");
    strictEqual(result.operator, "le_u");
  }

  const [carry, zero] = switchAction.defaultBody.actions;

  ok(
    carry !== undefined && isStatusFlagCall(carry) &&
      zero !== undefined && isStatusFlagCall(zero),
    "expected fallback flag resolution"
  );
  strictEqual(resolvedStatusFlag(carry), "CF");
  strictEqual(resolvedStatusFlag(zero), "ZF");

  const fallback = values.node(switchAction.defaultBody.result!);

  ok(fallback.kind === "binary", "expected fallback CF | ZF expression");
  strictEqual(fallback.operator, "or");
});

test("signed compare-family conditions sign-extend captured narrow lazy operands", () => {
  const { values, actions, flags } = createHarness();

  flags.condition("L");

  const switchAction = switchActions(actions)[0];

  ok(switchAction !== undefined, "expected lazy condition switch");
  const [, aRead, bRead] = actions.filter(isStateRead);

  ok(aRead !== undefined && bRead !== undefined, "expected captured lazy operands");

  for (const [index, switchCase] of switchAction.cases.entries()) {
    const width = [8, 16, 32][index] as 8 | 16 | 32;

    deepStrictEqual(switchCase.body.actions, []);
    strictEqual(
      switchCase.body.result,
      values.compare(width, "lt_s", aRead.output, bRead.output)
    );

    const result = values.node(switchCase.body.result!);

    ok(result.kind === "compare", "expected direct arm compare");
    strictEqual(result.operator, "lt_s");
  }
});

test("input-backed equality condition builds lazy cases from one captured record", () => {
  const { values, actions, flags } = createHarness();
  const condition = flags.condition("E");
  const switchAction = switchActions(actions)[0];

  ok(switchAction !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchAction.output);
  deepStrictEqual(switchAction.cases.map((entry) => entry.match), expectedLazyConditionCases("E"));
  const [, aRead, bRead] = actions.filter(isStateRead);

  ok(aRead !== undefined && bRead !== undefined, "expected captured lazy operands");
  for (const switchCase of switchAction.cases) {
    const kind = switchCase.match & 0b11;
    const width = lazyWidth(switchCase.match);
    const rightOperand: ValueId = kind === LAZY_FLAGS_KIND.LOGIC_RESULT
      ? values.const(0)
      : bRead.output;

    deepStrictEqual(switchCase.body.actions, []);
    strictEqual(switchCase.body.result, values.compare(width, "eq", aRead.output, rightOperand));
  }
});

test("condition falls back to live flag backings after a direct flag write", () => {
  const { values, actions, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const zero = values.const(0);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });
  flags.write("ZF", zero);

  strictEqual(flags.condition("E"), zero);
  strictEqual(
    flags.condition("NE"),
    values.compare(32, "eq", zero, zero)
  );
  deepStrictEqual(actions, []);
});

test("mixed pending and input condition combines pending values with resolver outputs", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);

  const condition = flags.condition("BE");
  const node = values.node(condition);

  ok(node.kind === "binary", "expected BE condition to lower to CF | ZF");
  strictEqual(node.operator, "or");
  deepStrictEqual(values.node(node.a), { kind: "actionOutput", type: "i32" });
  strictEqual(resolvedFlagValue(actions, "CF"), node.a);
  strictEqual(node.b, zf);
  strictEqual(switchActions(actions).length, 0);
});

test("non-compare-family input condition uses a typed resolver call", () => {
  const { actions, flags } = createHarness();
  const condition = flags.condition("S");

  const call = resolverCall(actions, "SF");

  ok(call !== undefined, "expected SF resolver call");
  strictEqual(call.outputs[0], condition);
  deepStrictEqual(stateReadSlots(actions), [
    lazyFlagsKindChannel,
    lazyFlagsAChannel,
    lazyFlagsBChannel,
    flagChannel("SF")
  ]);
  strictEqual(switchActions(actions).length, 0);
});

test("fault edge preserves a clean sub source while direct flag writes update completed fallback values", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);
  const source = { kind: "sub", width: 32, left, right, result } as const;

  flags.writeSource(source);
  pending.beginInstructionBoundary();
  flags.write("ZF", values.const(1));

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

  flags.writeSource({ kind: "logic", width: 8, result });

  strictEqual(flagValue(flags, "CF"), zero);
  strictEqual(flagValue(flags, "AF"), zero);
  strictEqual(flagValue(flags, "OF"), zero);
  strictEqual(flagValue(flags, "ZF"), values.compare(32, "eq", truncated, zero));
  strictEqual(flagValue(flags, "SF"), values.binary("shr_u", truncated, values.const(7)));

  const completedFlushes = pending.flushesForPath("completed");

  assertOnlyLazyRecord(completedFlushes, values, { kind: "LOGIC_RESULT", width: 8, result });
});

test("direct status flag writes set explicit pending values", () => {
  const { values, pending, flags } = createHarness();
  const explicit = Object.fromEntries(
    x86StatusFlags.map((flag, index) => [flag, values.const(index & 1)])
  ) as Record<(typeof x86StatusFlags)[number], ValueId>;

  for (const flag of x86StatusFlags) {
    flags.write(flag, explicit[flag]);
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

  flags.writeSource({ kind: "sub", width: 32, left, right, result });
  flags.write("ZF", zf);

  strictEqual(flagValue(flags, "CF"), values.compare(32, "lt_u", left, right));
  strictEqual(flagValue(flags, "ZF"), zf);

  const completedFlushes = pending.flushesForPath("completed");
  const snapshotValues = flagFlushEntries(completedFlushes);

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, zf);
});

test("a direct flag write from input state flushes a full explicit image from resolver calls", () => {
  const { values, actions, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);

  const completedFlushes = pending.flushesForPath("completed");

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(flagFlushValue(completedFlushes, "ZF"), zf);

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    const value = flagFlushValue(completedFlushes, flag);

    ok(value !== undefined, `expected ${flag} to be flushed`);
    deepStrictEqual(values.node(value), { kind: "actionOutput", type: "i32" });
    strictEqual(resolvedFlagValue(actions, flag), value);
  }
  deepStrictEqual(
    resolverCalls(actions).map(resolvedStatusFlag),
    x86StatusFlags
  );
  const calls = resolverCalls(actions);
  const sharedResolutionState = calls[0]?.arguments.slice(0, 3).map((argument) => argument.value);

  ok(sharedResolutionState !== undefined, "expected resolver calls");
  for (const call of calls) {
    deepStrictEqual(
      call.arguments.slice(0, 3).map((argument) => argument.value),
      sharedResolutionState
    );
  }
});

function flagValue(flags: StatusFlagState, flag: X86StatusFlag): ValueId {
  return flags.read(flag);
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

function lazyWidth(kindByte: number): 8 | 16 | 32 {
  switch (kindByte >> 2) {
    case 0:
      return 8;
    case 1:
      return 16;
    case 2:
      return 32;
    default:
      throw new Error(`invalid lazy flag kind byte: ${kindByte}`);
  }
}
