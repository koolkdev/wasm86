import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { RegionBuilder } from "#compiler/ir/builder/region.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { flagStateFields, type FlagStateField } from "#core/flags/layout.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import { InstructionState } from "../state/state.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  cpuStateAccess,
  cpuStatusFlagResolvers
} from "#test/support/execution-model.js";
import {
  isStatusFlagCall,
  resolvedStatusFlag,
  type StatusFlagCallOperation
} from "#test/support/storage-operations.js";
import {
  isStateRead,
  readsStateChannel,
  stateWriteValue,
  writesStateChannel,
  type StateReadOperation,
  type StateWriteOperation
} from "./state-operations.js";

type Harness = Readonly<{
  values: ValueTable;
  nodes(): readonly RegionNode[];
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

function createHarness(): Harness {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = new InstructionState(
    cpuStateAccess,
    cpuStatusFlagResolvers,
    instructionCountField
  );
  const access = state.bind(body);
  const context = { region: body, access };

  return {
    values,
    nodes: () => body.build().nodes,
    pending: {
      beginInstructionBoundary: () => state.beginInstructionBoundary(),
      flushesForPath: (path) =>
        state.flushesForPath(access, path).map((args) =>
          resourceWrite.create(args)
        )
    },
    flags: {
      read: (flag) => state.statusFlags.read(context, flag),
      condition: (cc) => state.statusFlags.condition(context, cc),
      write: (flag, value) => state.statusFlags.write(context, flag, value),
      writeSource: (source) =>
        state.statusFlags.writeSource(context, source),
      resetToInputs: () => state.statusFlags.resetToInputs()
    }
  };
}

function readsFor(
  values: ValueTable,
  nodes: readonly RegionNode[],
  field: FlagStateField
): StateReadOperation[] {
  return nodes.filter((node): node is StateReadOperation =>
    readsStateChannel(values, node, field)
  );
}

function writesFor(
  values: ValueTable,
  nodes: readonly RegionNode[],
  field: FlagStateField
): StateWriteOperation[] {
  return nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(values, node, field)
  );
}

function resolverCalls(
  nodes: readonly RegionNode[]
): StatusFlagCallOperation[] {
  return nodes.filter(isStatusFlagCall);
}

function concreteFlagWriteValue(
  values: ValueTable,
  writes: readonly RegionNode[],
  flag: X86StatusFlag
): ValueId | undefined {
  const matching = writesFor(
    values,
    writes,
    flagStateFields.concrete[flag]
  );

  return matching.length === 1
    ? stateWriteValue(matching[0]!)
    : undefined;
}

function assertFullExplicitFlush(
  values: ValueTable,
  writes: readonly StateWriteOperation[]
): void {
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
    values.constValue(stateWriteValue(kindWrites[0]!)),
    0,
    "explicit flags clear the lazy source kind"
  );
}

test("input flags resolve once without becoming dirty state", () => {
  const { nodes, pending, flags } = createHarness();

  strictEqual(pending.flushesForPath("fault").length, 0);
  strictEqual(pending.flushesForPath("completed").length, 0);

  const first = flags.read("ZF");

  strictEqual(flags.read("ZF"), first);
  strictEqual(nodes().filter(isStateRead).length, 0);

  const calls = resolverCalls(nodes());

  strictEqual(calls.length, 1);
  strictEqual(resolvedStatusFlag(calls[0]!), "ZF");
  strictEqual(calls[0]!.outputs[0], first);
  strictEqual(pending.flushesForPath("completed").length, 0);
});

test("resolving reset lazy fields preserves their fault rollback values", () => {
  const { values, nodes, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);

  pending.beginInstructionBoundary();
  flags.writeSource({
    kind: "sub",
    width: 32,
    left,
    right,
    result: values.binary("sub", left, right)
  });
  flags.resetToInputs();
  flags.read("ZF");

  for (const field of [
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ] as const) {
    const reads = readsFor(values, nodes(), field);
    const restores = writesFor(
      values,
      pending.flushesForPath("fault"),
      field
    );

    strictEqual(reads.length, 1, `${field.id} is captured`);
    strictEqual(restores.length, 1, `${field.id} is restored`);
    strictEqual(stateWriteValue(restores[0]!), reads[0]!.outputs[0]);
  }

  strictEqual(resolverCalls(nodes()).length, 1);
  strictEqual(pending.flushesForPath("completed").length, 0);
});

test("arm-local resolution keeps the current source and boundary source separate", () => {
  const values = new ValueTable();
  const root = new RegionBuilder(values);
  const state = new InstructionState(
    cpuStateAccess,
    cpuStatusFlagResolvers,
    instructionCountField
  );
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
    state.statusFlags.read(
      { region: arm, access: armAccess },
      "ZF"
    );
  });

  strictEqual(resolverCalls(arm.build().nodes).length, 1);
  deepStrictEqual(
    lazyRecordSnapshot(
      state.flushesForPath(rootAccess, "completed").map((args) =>
        resourceWrite.create(args)
      ),
      values
    ),
    { kindByte: 9, a: 7, b: 5 }
  );
  deepStrictEqual(
    lazyRecordSnapshot(
      state.flushesForPath(rootAccess, "fault").map((args) =>
        resourceWrite.create(args)
      ),
      values
    ),
    { kindByte: 9, a: 10, b: 3 }
  );
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
    deepStrictEqual(
      lazyRecordSnapshot(pending.flushesForPath("completed"), values),
      { kindByte: 9, a: 0x1234_5678, b: 0x1111_1111 }
    );
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
    deepStrictEqual(
      lazyRecordSnapshot(pending.flushesForPath("completed"), values),
      { kindByte: 2, a: 0xf0, b: 0x30 }
    );
  }

  {
    const { values, pending, flags } = createHarness();
    const result = values.const(0x1234_8000);

    flags.writeSource({ kind: "logic", width: 16, result });
    deepStrictEqual(
      lazyRecordSnapshot(pending.flushesForPath("completed"), values),
      { kindByte: 7, a: 0x8000 }
    );
  }
});

test("current lazy sources answer compare conditions without resolver calls", () => {
  const { values, nodes, flags } = createHarness();
  const left = values.parameter(0, "i32");
  const right = values.parameter(1, "i32");

  flags.writeSource({
    kind: "sub",
    width: 8,
    left,
    right,
    result: values.binary("sub", left, right)
  });

  for (const cc of ["E", "B", "L"] as const) {
    strictEqual(values.valueType(flags.condition(cc)), "i32");
  }

  strictEqual(nodes().length, 0);
});

test("input-backed compare conditions select lazy records with a resolver fallback", () => {
  const { values, nodes, flags } = createHarness();
  const condition = flags.condition("BE");
  const control = nodes().find((node) => node.kind === "switch");

  ok(control !== undefined, "compare-family input should select by lazy kind");
  strictEqual(control.output, condition);
  ok(control.cases.length > 0, "supported lazy records have direct cases");

  for (const field of [
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ] as const) {
    strictEqual(readsFor(values, nodes(), field).length, 1);
  }

  const fallbackFlags = new Set(
    resolverCalls(control.defaultBody.nodes).map(resolvedStatusFlag)
  );

  strictEqual(fallbackFlags.has("CF"), true);
  strictEqual(fallbackFlags.has("ZF"), true);
  ok(control.defaultBody.result !== undefined);
  ok(control.cases.every((entry) => entry.body.result !== undefined));
});

test("non-compare input conditions use their typed resolver directly", () => {
  const { nodes, flags } = createHarness();
  const condition = flags.condition("S");
  const calls = resolverCalls(nodes());

  strictEqual(calls.length, 1);
  strictEqual(resolvedStatusFlag(calls[0]!), "SF");
  strictEqual(calls[0]!.outputs[0], condition);
  strictEqual(nodes().some((node) => node.kind === "switch"), false);
});

test("pending and input-backed flags combine without constructing a lazy switch", () => {
  const { values, nodes, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);
  const condition = flags.condition("BE");
  const expression = values.node(condition);

  ok(expression.kind === "binary");
  strictEqual(expression.operator, "or");
  strictEqual(
    resolverCalls(nodes()).some((call) => resolvedStatusFlag(call) === "CF"),
    true
  );
  strictEqual(nodes().some((node) => node.kind === "switch"), false);
});

test("writing the current value preserves clean or lazy state", () => {
  {
    const { pending, flags } = createHarness();
    const input = flags.read("ZF");

    flags.write("ZF", input);
    strictEqual(pending.flushesForPath("completed").length, 0);
  }

  {
    const { values, pending, flags } = createHarness();
    const left = values.const(7);
    const right = values.const(3);

    flags.writeSource({
      kind: "sub",
      width: 32,
      left,
      right,
      result: values.binary("sub", left, right)
    });
    flags.write("ZF", flags.read("ZF"));

    deepStrictEqual(
      lazyRecordSnapshot(pending.flushesForPath("completed"), values),
      { kindByte: 9, a: 7, b: 3 }
    );
  }
});

test("a direct flag write materializes one explicit architectural image", () => {
  const { values, nodes, pending, flags } = createHarness();
  const zf = values.const(1);

  flags.write("ZF", zf);
  const completed = pending.flushesForPath("completed");

  assertFullExplicitFlush(values, completed);
  strictEqual(
    concreteFlagWriteValue(values, completed, "ZF"),
    zf
  );

  const resolved = new Set(resolverCalls(nodes()).map(resolvedStatusFlag));

  for (const flag of x86StatusFlags) {
    strictEqual(resolved.has(flag), true, `${flag} has an input backing`);
  }
});

test("fault and completed paths retain different flag images", () => {
  const { values, pending, flags } = createHarness();
  const left = values.const(7);
  const right = values.const(3);

  flags.writeSource({
    kind: "sub",
    width: 32,
    left,
    right,
    result: values.binary("sub", left, right)
  });
  pending.beginInstructionBoundary();
  flags.write("ZF", values.const(1));

  deepStrictEqual(
    lazyRecordSnapshot(pending.flushesForPath("fault"), values),
    { kindByte: 9, a: 7, b: 3 }
  );

  const completed = pending.flushesForPath("completed");

  assertFullExplicitFlush(values, completed);
  strictEqual(
    values.constValue(
      concreteFlagWriteValue(values, completed, "ZF")!
    ),
    1
  );
});

type LazyRecordSnapshot = Readonly<{
  kindByte: number;
  a: number;
  b?: number;
}>;

function lazyRecordSnapshot(
  writes: readonly StateWriteOperation[],
  values: ValueTable
): LazyRecordSnapshot {
  const kindByte = constantStateFieldWrite(
    writes,
    values,
    flagStateFields.lazyKind
  );
  const a = constantStateFieldWrite(
    writes,
    values,
    flagStateFields.lazyA
  );
  const bWrite = writes.find((write) =>
    writesStateChannel(values, write, flagStateFields.lazyB)
  );

  if (bWrite === undefined) {
    return { kindByte, a };
  }

  const b = values.constValue(stateWriteValue(bWrite));

  ok(b !== undefined, "lazy B must be a literal in this fixture");
  return { kindByte, a, b };
}

function constantStateFieldWrite(
  writes: readonly StateWriteOperation[],
  values: ValueTable,
  field: FlagStateField
): number {
  const write = writes.find((node) =>
    writesStateChannel(values, node, field)
  );

  ok(write !== undefined, `${field.id} was not committed`);
  const value = values.constValue(stateWriteValue(write));

  ok(value !== undefined, `${field.id} must be a literal in this fixture`);
  return value;
}
