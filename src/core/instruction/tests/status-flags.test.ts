import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { BodyNode } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { InstructionState } from "../state/state.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import {
  flagStateFields,
  type FlagStateField
} from "#core/flags/layout.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  resourceWrite,
  type ResourceWriteArgs
} from "#compiler/ir/operations/resource.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import { simpleFlagSourceConditionOperators } from "#core/flags/lazy/sources.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { assertOnlyLazyRecord } from "./lazy-flags.js";
import {
  isStatusFlagCall,
  resolvedStatusFlag,
  statusFlagCallOperation,
  type StatusFlagCallOperation
} from "#ir/tests/storage-op-helpers.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  cpuStateAccess,
  cpuStatusFlagResolvers
} from "#test/support/execution-model.js";
import { covers } from "#ir/aliasing.js";
import {
  stateEffect,
  stateWriteValue,
  isStateRead,
  isStateWrite,
  type StateWriteOperation
} from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  nodes: BodyNode[];
  pending: Readonly<{
    beginInstructionBoundary(): void;
    flushesForPath(path: "fault" | "completed"): readonly StateWriteOperation[];
  }>;
  flags: TestStatusFlags;
}>;

type TestStatusFlags = Readonly<{
  read(flag: X86StatusFlag): ValueId;
  condition(cc: ConditionCode): ValueId;
  write(flag: X86StatusFlag, value: ValueId): void;
  writeSource(source: SimpleFlagSource): void;
  resetToInputs(): void;
}>;

function stateWriteOperations(nodes: readonly BodyNode[]): readonly StateWriteOperation[] {
  return nodes.filter(isStateWrite);
}

function materializeStateWrites(
  writes: readonly ResourceWriteArgs[]
): readonly StateWriteOperation[] {
  return writes.map((args) => resourceWrite.create(args));
}

function assertDirectCompare(
  values: ValueTable,
  result: ValueId,
  width: 8 | 16 | 32,
  operator: "le_u" | "lt_s" | "eq",
  a: ValueId,
  b: ValueId
): void {
  const compare = values.node(result);

  if (operator === "eq" && values.constValue(b) === 0) {
    ok(compare.kind === "unary", "expected direct arm zero comparison");
    strictEqual(compare.operator, "eqz");
    assertAdjustedOperand(values, compare.value, width, a, false);
    return;
  }

  ok(compare.kind === "compare", "expected direct arm compare");
  strictEqual(compare.operator, operator);
  assertAdjustedOperand(values, compare.a, width, a, operator === "lt_s");
  assertAdjustedOperand(values, compare.b, width, b, operator === "lt_s");
}

function assertAdjustedOperand(
  values: ValueTable,
  actual: ValueId,
  width: 8 | 16 | 32,
  input: ValueId,
  signed: boolean
): void {
  if (width === 32 || values.widthBounds(input)[signed ? "signedBits" : "unsignedBits"] <= width) {
    strictEqual(actual, input);
    return;
  }

  const adjusted = values.node(actual);

  if (signed) {
    ok(adjusted.kind === "extend", "expected sign-extended compare operand");
    strictEqual(adjusted.signed, true);
  } else {
    ok(adjusted.kind === "truncate", "expected truncated compare operand");
  }
  strictEqual(adjusted.width, width);
  strictEqual(adjusted.value, input);
}

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const nodes = body.build().nodes as BodyNode[];
  const state = new InstructionState(
    cpuStateAccess,
    cpuStatusFlagResolvers,
    instructionCountField
  );
  const access = state.bind(body);
  const context = { region: body, access };

  return {
    values,
    nodes,
    pending: {
      beginInstructionBoundary: () => state.beginInstructionBoundary(),
      flushesForPath: (path) => materializeStateWrites(
        state.flushesForPath(access, path)
      )
    },
    flags: {
      read: (flag) => state.statusFlags.read(context, flag),
      condition: (cc) => state.statusFlags.condition(context, cc),
      write: (flag, value) => state.statusFlags.write(context, flag, value),
      writeSource: (source) => state.statusFlags.writeSource(context, source),
      resetToInputs: () => state.statusFlags.resetToInputs()
    }
  };
}

function flagFlushEntries(
  nodes: readonly StateWriteOperation[],
  values: ValueTable
): ReadonlyArray<Readonly<{ flag: X86StatusFlag; value: ValueId }>> {
  return nodes.flatMap((node) => {
    const flag = x86StatusFlags.find((candidate) => effectsEqual(
      node.effect,
      stateEffect(values, flagStateFields.concrete[candidate])
    ));

    return flag === undefined
      ? []
      : [{ flag, value: stateWriteValue(node) }];
  });
}

function flagFlushValue(
  nodes: readonly StateWriteOperation[],
  values: ValueTable,
  flag: X86StatusFlag
): ValueId | undefined {
  return flagFlushEntries(nodes, values).find((entry) => entry.flag === flag)?.value;
}

function assertFullExplicitFlush(
  nodes: readonly StateWriteOperation[],
  values: ValueTable
): void {
  deepStrictEqual(flagFlushEntries(nodes, values).map((entry) => entry.flag), x86StatusFlags);
  const kindWrite = nodes.find((node) => effectsEqual(
    node.effect,
    stateEffect(values, flagStateFields.lazyKind)
  ));

  strictEqual(
    kindWrite === undefined ? undefined : stateWriteValue(kindWrite),
    values.const(0)
  );
  strictEqual(nodes.length, x86StatusFlags.length + 1);
}

function resolverCall(nodes: readonly BodyNode[], flag: X86StatusFlag): StatusFlagCallOperation | undefined {
  return nodes.find(
    (node): node is StatusFlagCallOperation =>
      isStatusFlagCall(node) && resolvedStatusFlag(node) === flag
  );
}

function resolvedFlagValue(nodes: readonly BodyNode[], flag: X86StatusFlag): ValueId | undefined {
  return resolverCall(nodes, flag)?.outputs[0];
}

function resolverCalls(nodes: readonly BodyNode[]): readonly StatusFlagCallOperation[] {
  return nodes.filter(isStatusFlagCall);
}

function stateReadFields(
  nodes: readonly BodyNode[],
  values: ValueTable
): readonly FlagStateField[] {
  const candidates: readonly FlagStateField[] = [
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB,
    ...x86StatusFlags.map((flag) => flagStateFields.concrete[flag])
  ];

  return nodes.filter(isStateRead).map((node) => {
    const channel = candidates.find((candidate) => effectsEqual(
      node.effect,
      stateEffect(values, candidate)
    ));

    if (channel === undefined) {
      throw new Error("unrecognized execution-state read effect");
    }
    return channel;
  });
}

function effectsEqual(
  left: Parameters<typeof covers>[0],
  right: Parameters<typeof covers>[1]
): boolean {
  return covers(left, right) && covers(right, left);
}

function assertResolverCall(
  control: StatusFlagCallOperation,
  output: ValueId,
  flag: X86StatusFlag
): void {
  deepStrictEqual(control, statusFlagCallOperation(output, flag));
}

function switchControls(nodes: readonly BodyNode[]): Extract<BodyNode, { kind: "switch" }>[] {
  return nodes.filter((node): node is Extract<BodyNode, { kind: "switch" }> => node.kind === "switch");
}

test("new status flags start with no dirty pending entries", () => {
  const { pending } = createHarness();

  deepStrictEqual(stateWriteOperations(pending.flushesForPath("fault")), []);
  deepStrictEqual(stateWriteOperations(pending.flushesForPath("completed")), []);
});

test("input status flags use a cached direct-state resolver call", () => {
  const { values, nodes, flags } = createHarness();
  const first = flags.read("ZF");
  const second = flags.read("ZF");

  strictEqual(first, second);
  deepStrictEqual(stateReadFields(nodes, values), []);
  const call = resolverCall(nodes, "ZF");

  ok(call !== undefined, "expected ZF resolver call");
  assertResolverCall(call, first, "ZF");
  strictEqual(nodes.at(-1), call);
  deepStrictEqual(values.node(first), { kind: "nodeOutput", type: "i32" });
});

test("a direct-state resolver observes pending lazy fields without weakening fault rollback", () => {
  const { values, nodes, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  pending.beginInstructionBoundary();
  flags.writeSource({ kind: "sub", width: 32, left, right, result });
  flags.resetToInputs();
  const resolved = flags.read("ZF");
  const reads = nodes.filter(isStateRead);
  const writes = stateWriteOperations(nodes);
  const call = resolverCall(nodes, "ZF");

  deepStrictEqual(new Set(stateReadFields(reads, values)), new Set([
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ]));
  assertOnlyLazyRecord(writes, values, {
    kind: "SUB",
    width: 32,
    left,
    right
  });
  ok(call !== undefined, "expected ZF resolver call");
  assertResolverCall(call, resolved, "ZF");
  strictEqual(nodes.at(-1), call);
  deepStrictEqual(stateWriteOperations(pending.flushesForPath("completed")), []);

  const faultWrites = stateWriteOperations(pending.flushesForPath("fault"));

  strictEqual(faultWrites.length, reads.length);
  for (const read of reads) {
    const restore = faultWrites.find((write) =>
      effectsEqual(write.effect, read.effect)
    );

    ok(restore !== undefined, "expected a fault restore for each published field");
    strictEqual(stateWriteValue(restore), read.outputs[0]);
  }
});

test("an arm-local resolver preserves rollback for carried lazy state", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const state = new InstructionState(
    cpuStateAccess,
    cpuStatusFlagResolvers,
    instructionCountField
  );
  const before = {
    kind: "sub" as const,
    width: 32 as const,
    left: values.const(10),
    right: values.const(3)
  };
  const after = {
    kind: "sub" as const,
    width: 32 as const,
    left: values.const(7),
    right: values.const(5)
  };
  const rootContext = { region: root, access: state.bind(root) };

  state.statusFlags.writeSource(rootContext, {
    ...before,
    result: values.binary("sub", before.left, before.right)
  });
  state.beginInstructionBoundary();
  state.statusFlags.writeSource(rootContext, {
    ...after,
    result: values.binary("sub", after.left, after.right)
  });
  state.statusFlags.resetToInputs();

  const selected = root.child();
  const selectedAccess = state.bind(selected);
  const resolved = state.enterScope(() => {
    return state.statusFlags.read(
      { region: selected, access: selectedAccess },
      "ZF"
    );
  });
  const selectedActions = selected.build().nodes;
  const call = resolverCall(selectedActions, "ZF");

  assertOnlyLazyRecord(stateWriteOperations(selectedActions), values, {
    kind: "SUB",
    width: after.width,
    left: after.left,
    right: after.right
  });
  ok(call !== undefined, "expected a selected-body ZF resolver call");
  assertResolverCall(call, resolved, "ZF");

  assertOnlyLazyRecord(
    materializeStateWrites(state.flushesForPath(state.bind(root), "completed")),
    values,
    {
      kind: "SUB",
      width: after.width,
      left: after.left,
      right: after.right
    }
  );
  assertOnlyLazyRecord(
    materializeStateWrites(state.flushesForPath(state.bind(root), "fault")),
    values,
    {
      kind: "SUB",
      width: before.width,
      left: before.left,
      right: before.right
    }
  );
});

test("sibling status sources and direct conditions construct independently", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const state = new InstructionState(
    cpuStateAccess,
    cpuStatusFlagResolvers,
    instructionCountField
  );
  const left = values.external(0);
  const right = values.external(1);
  const build = (selected: RegionBuilder) => state.enterScope(() => {
    const access = state.bind(selected);
    const context = { region: selected, access };
    const result = selected.values.binary("sub", left, right);

    state.statusFlags.writeSource(context, {
      kind: "sub",
      width: 8,
      left,
      right,
      result
    });
    const below = state.statusFlags.condition(context, "B");
    const writes = stateWriteOperations(materializeStateWrites(
      state.flushesForPath(access, "completed")
    ));
    const lazyA = writes.find((write) => effectsEqual(
      write.effect,
      stateEffect(values, flagStateFields.lazyA)
    ));
    const lazyB = writes.find((write) => effectsEqual(
      write.effect,
      stateEffect(values, flagStateFields.lazyB)
    ));

    ok(lazyA !== undefined && lazyB !== undefined, "expected a complete lazy SUB record");
    return {
      narrowedLeft: stateWriteValue(lazyA),
      narrowedRight: stateWriteValue(lazyB),
      below
    };
  });
  const first = build(root.child());
  const second = build(root.child());

  notStrictEqual(first.narrowedLeft, second.narrowedLeft);
  notStrictEqual(first.narrowedRight, second.narrowedRight);
  notStrictEqual(first.below, second.below);
  deepStrictEqual(values.node(first.below), {
    kind: "compare",
    type: "i32",
    operator: "lt_u",
    a: first.narrowedLeft,
    b: first.narrowedRight
  });
  deepStrictEqual(values.node(first.narrowedLeft), values.node(second.narrowedLeft));
  deepStrictEqual(values.node(first.narrowedRight), values.node(second.narrowedRight));
  deepStrictEqual(values.node(second.below), {
    kind: "compare",
    type: "i32",
    operator: "lt_u",
    a: second.narrowedLeft,
    b: second.narrowedRight
  });
});

test("writing the current input status flag value is a no-op", () => {
  const { pending, flags } = createHarness();
  const zf = flags.read("ZF");

  flags.write("ZF", zf);

  deepStrictEqual(stateWriteOperations(pending.flushesForPath("completed")), []);
});

test("a sub source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });

  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));

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

  assertOnlyLazyRecord(stateWriteOperations(pending.flushesForPath("completed")), values, { kind: "SUB", width: 32, left, right });
});

test("an add source commits a lazy runtime record", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0xffff_ffff);
  const right = values.const(1);
  const result = values.binary("add", left, right);

  flags.writeSource({ kind: "add", width: 32, left, right, result });

  assertOnlyLazyRecord(stateWriteOperations(pending.flushesForPath("completed")), values, { kind: "ADD", width: 32, left, right });
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

  assertOnlyLazyRecord(stateWriteOperations(pending.flushesForPath("completed")), values, { kind: "SUB", width: 16, left, right });
});

test("add lazy commits truncated narrow operands", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(0x1234_5678);
  const right = values.const(0x8765_4321);
  const result = values.binary("add", left, right);

  flags.writeSource({ kind: "add", width: 8, left, right, result });

  assertOnlyLazyRecord(stateWriteOperations(pending.flushesForPath("completed")), values, { kind: "ADD", width: 8, left, right });
});

test("condition uses the current sub source directly", () => {
  const { values, nodes, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);
  const result = values.binary("sub", left, right);

  flags.writeSource({ kind: "sub", width: 32, left, right, result });

  strictEqual(flags.condition("E"), values.compare(32, "eq", left, right));
  strictEqual(flags.condition("B"), values.compare(32, "lt_u", left, right));
  strictEqual(flags.condition("L"), values.compare(32, "lt_s", left, right));
  deepStrictEqual(nodes, []);
});

test("input-backed compare-family condition builds a lazy SUB switch", () => {
  const { values, nodes, flags } = createHarness();
  const condition = flags.condition("BE");
  const switchControl = switchControls(nodes)[0];

  ok(switchControl !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchControl.output);
  strictEqual(nodes.length, 4);
  const selectorRead = nodes[0];

  ok(
    selectorRead !== undefined && isStateRead(selectorRead),
    "expected lazy-kind state read"
  );
  strictEqual(selectorRead.outputs[0], switchControl.selector);
  strictEqual(
    effectsEqual(
      selectorRead.effect,
      stateEffect(values, flagStateFields.lazyKind)
    ),
    true
  );
  deepStrictEqual(
    switchControl.cases.flatMap((entry) => entry.matches),
    [8, 16, 32].map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, width as 8 | 16 | 32))
  );
  const [kindRead, aRead, bRead] = nodes.filter(isStateRead);

  ok(kindRead !== undefined && aRead !== undefined && bRead !== undefined, "expected lazy record reads");
  const a = aRead.outputs[0];
  const b = bRead.outputs[0];

  ok(a !== undefined && b !== undefined, "expected lazy record read outputs");
  deepStrictEqual(stateReadFields([kindRead, aRead, bRead], values), [
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ]);

  for (const [index, switchCase] of switchControl.cases.entries()) {
    const width = [8, 16, 32][index] as 8 | 16 | 32;

    deepStrictEqual(switchCase.body.nodes, []);
    assertDirectCompare(values, switchCase.body.result!, width, "le_u", a, b);
  }

  const [carry, zero] = switchControl.defaultBody.nodes;

  ok(
    carry !== undefined && isStatusFlagCall(carry) &&
      zero !== undefined && isStatusFlagCall(zero),
    "expected fallback flag resolution"
  );
  strictEqual(resolvedStatusFlag(carry), "CF");
  strictEqual(resolvedStatusFlag(zero), "ZF");

  const fallback = values.node(switchControl.defaultBody.result!);

  ok(fallback.kind === "binary", "expected fallback CF | ZF expression");
  strictEqual(fallback.operator, "or");
});

test("signed compare-family conditions sign-extend captured narrow lazy operands", () => {
  const { values, nodes, flags } = createHarness();

  flags.condition("L");

  const switchControl = switchControls(nodes)[0];

  ok(switchControl !== undefined, "expected lazy condition switch");
  const [, aRead, bRead] = nodes.filter(isStateRead);

  ok(aRead !== undefined && bRead !== undefined, "expected captured lazy operands");
  const a = aRead.outputs[0];
  const b = bRead.outputs[0];

  ok(a !== undefined && b !== undefined, "expected captured lazy operand outputs");

  for (const [index, switchCase] of switchControl.cases.entries()) {
    const width = [8, 16, 32][index] as 8 | 16 | 32;

    deepStrictEqual(switchCase.body.nodes, []);
    assertDirectCompare(values, switchCase.body.result!, width, "lt_s", a, b);
  }
});

test("input-backed equality condition builds lazy cases from one captured record", () => {
  const { values, nodes, flags } = createHarness();
  const condition = flags.condition("E");
  const switchControl = switchControls(nodes)[0];

  ok(switchControl !== undefined, "expected lazy condition switch");
  strictEqual(condition, switchControl.output);
  deepStrictEqual(
    switchControl.cases.flatMap((entry) => entry.matches),
    expectedLazyConditionCases("E")
  );
  const [, aRead, bRead] = nodes.filter(isStateRead);

  ok(aRead !== undefined && bRead !== undefined, "expected captured lazy operands");
  const a = aRead.outputs[0];
  const b = bRead.outputs[0];

  ok(a !== undefined && b !== undefined, "expected captured lazy operand outputs");
  for (const switchCase of switchControl.cases) {
    strictEqual(switchCase.matches.length, 1);
    const match = switchCase.matches[0]!;
    const kind = match & 0b11;
    const width = lazyWidth(match);
    const rightOperand: ValueId = kind === LAZY_FLAGS_KIND.LOGIC_RESULT
      ? values.const(0)
      : b;

    deepStrictEqual(switchCase.body.nodes, []);
    assertDirectCompare(
      values,
      switchCase.body.result!,
      width,
      "eq",
      a,
      rightOperand
    );
  }
});

test("condition falls back to live flag backings after a direct flag write", () => {
  const { values, nodes, flags } = createHarness();
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
  deepStrictEqual(nodes, []);
});

test("mixed pending and input condition combines pending values with resolver outputs", () => {
  const { values, nodes, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);

  const condition = flags.condition("BE");
  const node = values.node(condition);

  ok(node.kind === "binary", "expected BE condition to lower to CF | ZF");
  strictEqual(node.operator, "or");
  deepStrictEqual(values.node(node.a), { kind: "nodeOutput", type: "i32" });
  strictEqual(resolvedFlagValue(nodes, "CF"), node.a);
  strictEqual(node.b, zf);
  strictEqual(switchControls(nodes).length, 0);
});

test("non-compare-family input condition uses a typed resolver call", () => {
  const { values, nodes, flags } = createHarness();
  const condition = flags.condition("S");

  const call = resolverCall(nodes, "SF");

  ok(call !== undefined, "expected SF resolver call");
  strictEqual(call.outputs[0], condition);
  deepStrictEqual(stateReadFields(nodes, values), []);
  strictEqual(switchControls(nodes).length, 0);
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

  const faultFlushes = stateWriteOperations(pending.flushesForPath("fault"));
  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));

  assertOnlyLazyRecord(faultFlushes, values, { kind: "SUB", width: 32, left, right });
  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(
    flagFlushValue(completedFlushes, values, "ZF"),
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

  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));

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

  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));
  const snapshotValues = flagFlushEntries(completedFlushes, values);

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

  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));
  const snapshotValues = flagFlushEntries(completedFlushes, values);

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(snapshotValues.length, x86StatusFlags.length);
  strictEqual(snapshotValues.find((entry) => entry.flag === "ZF")?.value, zf);
});

test("a direct flag write from input state flushes a full explicit image from resolver calls", () => {
  const { values, nodes, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);

  const completedFlushes = stateWriteOperations(pending.flushesForPath("completed"));

  assertFullExplicitFlush(completedFlushes, values);
  strictEqual(flagFlushValue(completedFlushes, values, "ZF"), zf);

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    const value = flagFlushValue(completedFlushes, values, flag);

    ok(value !== undefined, `expected ${flag} to be flushed`);
    deepStrictEqual(values.node(value), { kind: "nodeOutput", type: "i32" });
    strictEqual(resolvedFlagValue(nodes, flag), value);
  }
  deepStrictEqual(
    resolverCalls(nodes).map(resolvedStatusFlag),
    x86StatusFlags
  );
  strictEqual(resolverCalls(nodes).every((call) => call.inputs.length === 0), true);
});

function flagValue(flags: TestStatusFlags, flag: X86StatusFlag): ValueId {
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
