import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { test } from "node:test";

import type { Action, WriteStateAction } from "#ir/actions.js";
import { PendingFlags } from "#ir/pending/flags.js";
import { StateAccess } from "#ir/pending/state-access.js";
import { flagChannel } from "#ir/slots.js";
import { createValueTable, type ValueId, type ValueTable } from "#ir/values.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";

type Harness = Readonly<{
  values: ValueTable;
  actions: Action[];
  flags: PendingFlags;
}>;

function createHarness(): Harness {
  const values = createValueTable();
  const actions: Action[] = [];
  const state = new StateAccess(values, (action) => actions.push(action));

  return { values, actions, flags: new PendingFlags(values, state) };
}

function writeStateActions(actions: readonly Action[]): WriteStateAction[] {
  return actions.filter((action): action is WriteStateAction => action.kind === "writeState");
}

test("new pending flags start with no dirty entries", () => {
  const { flags } = createHarness();

  deepStrictEqual(flags.entries(), []);
  deepStrictEqual(flags.snapshot(), []);
});

test("input flags read through cached state bytes", () => {
  const { actions, flags } = createHarness();
  const first = flags.readFlag("ZF");
  const second = flags.readFlag("ZF");

  strictEqual(first, second);
  deepStrictEqual(actions, [{ kind: "readState", output: first, slot: flagChannel("ZF") }]);
});

test("a sub source materializes every status flag", () => {
  const { values, actions, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });

  deepStrictEqual(
    flags.entries().map(([slot]) => slot),
    x86StatusFlags.map((flag) => flagChannel(flag))
  );
  strictEqual(
    pendingFlagValue(flags, "ZF"),
    values.internCompare("eq", result, values.internConst(0))
  );

  flags.flushAll();

  const writes = writeStateActions(actions);

  deepStrictEqual(
    writes.map((action) => action.slot),
    x86StatusFlags.map((flag) => flagChannel(flag))
  );
  strictEqual(
    writes.find((action) => action.slot === flagChannel("ZF"))?.value,
    values.internCompare("eq", result, values.internConst(0))
  );
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

test("a logic source materializes fixed, undefined, and derived flag values", () => {
  const { values, actions, flags } = createHarness();
  const result = values.internConst(0x80);
  const projected = values.projectTo(8, result);
  const zero = values.internConst(0);

  flags.writeStatusFlagsSource({ kind: "logic", width: 8, result });

  strictEqual(pendingFlagValue(flags, "CF"), zero);
  strictEqual(pendingFlagValue(flags, "AF"), zero);
  strictEqual(pendingFlagValue(flags, "OF"), zero);
  strictEqual(pendingFlagValue(flags, "ZF"), values.internCompare("eq", projected, zero));
  strictEqual(pendingFlagValue(flags, "SF"), values.internBinary("shr_u", projected, values.internConst(7)));

  flags.flushAll();

  const writes = writeStateActions(actions);

  strictEqual(writes.find((action) => action.slot === flagChannel("CF"))?.value, zero);
  strictEqual(writes.find((action) => action.slot === flagChannel("AF"))?.value, zero);
  strictEqual(writes.find((action) => action.slot === flagChannel("OF"))?.value, zero);
});

test("direct status flag writes set concrete pending values", () => {
  const { values, actions, flags } = createHarness();
  const concrete = Object.fromEntries(
    x86StatusFlags.map((flag, index) => [flag, values.internConst(index & 1)])
  ) as Record<(typeof x86StatusFlags)[number], number>;

  for (const flag of x86StatusFlags) {
    flags.writeFlag(flag, concrete[flag]);
  }

  for (const flag of x86StatusFlags) {
    strictEqual(pendingFlagValue(flags, flag), concrete[flag]);
  }

  flags.flushAll();

  const writes = writeStateActions(actions);

  strictEqual(writes.length, x86StatusFlags.length);
  strictEqual(writes.find((action) => action.slot === flagChannel("ZF"))?.value, concrete.ZF);
});

test("writeFlag updates one status flag while preserving other pending values", () => {
  const { values, actions, flags } = createHarness();
  const left = values.internConst(7);
  const right = values.internConst(3);
  const result = values.internBinary("sub", left, right);
  const zf = values.internConst(1);

  flags.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  flags.writeFlag("ZF", zf);

  strictEqual(pendingFlagValue(flags, "CF"), values.internCompare("lt_u", left, right));
  strictEqual(pendingFlagValue(flags, "ZF"), zf);

  flags.flushAll();

  const writes = writeStateActions(actions);

  strictEqual(writes.length, x86StatusFlags.length);
  strictEqual(writes.find((action) => action.slot === flagChannel("ZF"))?.value, zf);
});

test("a direct flag write from input state flushes only that flag", () => {
  const { values, actions, flags } = createHarness();
  const zf = values.internConst(1);

  flags.writeFlag("ZF", zf);
  flags.flushAll();

  deepStrictEqual(actions, [{ kind: "writeState", slot: flagChannel("ZF"), value: zf }]);
});

function pendingFlagValue(flags: PendingFlags, flag: X86StatusFlag): ValueId {
  const entry = flags.entries().find(([slot]) => slot === flagChannel(flag));

  ok(entry !== undefined, `missing pending entry for ${flag}`);

  return entry[1];
}
