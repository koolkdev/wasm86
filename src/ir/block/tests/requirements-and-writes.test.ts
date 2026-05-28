import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import {
  definitionDemandsForRequirement,
  requirementsForSchedule,
  type BlockRequirement
} from "#ir/block/requirements.js";
import type {
  BlockSchedule,
  BlockScheduleEntry
} from "#ir/block/schedule.js";
import {
  writeOverlapsDependencies,
  writesForEntry
} from "#ir/block/writes.js";
import { exprDependencies } from "#ir/expr/dependencies.js";
import {
  exprConst,
  exprInput,
  exprProject
} from "#ir/expr/builders.js";
import { bitsUse } from "#ir/expr/uses.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import { registerAlias } from "#x86/registers.js";

test("requirements expose direct block definition demands with requested uses", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 16 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 16 }
    ]
  });
  const load = definitionEntry(result.schedule, "memoryLoad");
  const requirement = actionInputRequirement(
    requirementsForSchedule(result.schedule),
    "memoryStore",
    "value"
  );
  const demands = definitionDemandsForRequirement(requirement);

  strictEqual(demands.length, 1);
  deepStrictEqual(
    { id: demands[0]!.id, use: demands[0]!.use },
    { id: load.definition.id, use: bitsUse(0xffff) }
  );
  strictEqual(demands[0]!.root, requirement.root);
  strictEqual(demands[0]!.entry, requirement.entry);
});

test("requirements reject missing and late block definitions", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
    ]
  });
  const load = definitionEntry(result.schedule, "memoryLoad");
  const store = actionEntry(result.schedule, "memoryStore");

  throws(
    () => requirementsForSchedule([store, load]),
    /observed before its definition placement/
  );
  throws(
    () => requirementsForSchedule([store]),
    /not present in the schedule/
  );
});

test("requirements API exposes root views without copied effect lists", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const requirements = requirementsForSchedule(result.schedule);
  const requirement = requirements[0]!;

  deepStrictEqual(Object.keys(requirement), ["root", "expr", "use", "at", "entry"]);
  strictEqual(Object.hasOwn(requirements, "effects"), false);
  strictEqual(Object.hasOwn(requirement, "effects"), false);
  strictEqual(Object.hasOwn(requirement, "action"), false);
  strictEqual(Object.hasOwn(requirement, "definition"), false);
});

test("write queries report state-sync register and flag writes", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "flags.write", cells: { ZF: { kind: "expr", value: c(1) } } },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const writes = writesForEntry(boundaryEntry(result.schedule, "stateSync"));

  strictEqual(writes.some((write) =>
    write.kind === "reg" && write.reg.name === "esp"
  ), true);
  strictEqual(writes.some((write) =>
    write.kind === "flag" && write.flag === "ZF"
  ), true);
});

test("write queries report dynamic-register writes through binding clobbers", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 8 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 8)]
    })
  });
  const store = actionEntry(result.schedule, "dynamicRegisterStore");
  const writes = writesForEntry(store);

  deepStrictEqual(writes, [
    { kind: "dynamicReg", binding: dynamicRegBinding(store.action.index, store.action.width) }
  ]);
  strictEqual(
    writeOverlapsDependencies(writes[0]!, [{ kind: "reg", reg: "eax", mask: 0xff00 }]),
    true
  );
  strictEqual(
    writeOverlapsDependencies(writes[0]!, [{ kind: "reg", reg: "esp", mask: 0xffff_ffff }]),
    false
  );
});

test("write dependency overlap is precise for register aliases", () => {
  const lowByteDeps = exprDependencies(exprProject(8, exprInput({ kind: "reg", reg: "eax" })));

  strictEqual(
    writeOverlapsDependencies({ kind: "reg", reg: registerAlias("ah") }, lowByteDeps),
    false
  );
  strictEqual(
    writeOverlapsDependencies({ kind: "reg", reg: registerAlias("al") }, lowByteDeps),
    true
  );
  strictEqual(
    writeOverlapsDependencies({ kind: "reg", reg: registerAlias("ebx") }, lowByteDeps),
    false
  );
});

function actionInputRequirement(
  requirements: readonly BlockRequirement[],
  kind: BlockAction["kind"],
  input: Extract<BlockRequirement["root"]["purpose"], { kind: "actionInput" }>["input"]
): BlockRequirement {
  const requirement = requirements.find((entry) =>
    entry.root.entry.role === "action" &&
      entry.root.entry.action.kind === kind &&
      entry.root.purpose.kind === "actionInput" &&
      entry.root.purpose.input === input
  );

  if (requirement === undefined) {
    throw new Error(`missing ${kind} ${input} requirement`);
  }

  return requirement;
}

function actionEntry<TKind extends BlockAction["kind"]>(
  schedule: BlockSchedule,
  kind: TKind
): Extract<BlockScheduleEntry, { role: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: TKind }> }> {
  const entry = schedule.find((item) =>
    item.role === "action" && item.action.kind === kind
  );

  if (entry === undefined || entry.role !== "action" || entry.action.kind !== kind) {
    throw new Error(`missing action ${kind}`);
  }

  return entry as Extract<BlockScheduleEntry, { role: "action" }> &
    Readonly<{ action: Extract<BlockAction, { kind: TKind }> }>;
}

function definitionEntry<TKind extends BlockDefinition["kind"]>(
  schedule: BlockSchedule,
  kind: TKind
): Extract<BlockScheduleEntry, { role: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }> {
  const entry = schedule.find((item) =>
    item.role === "definition" && item.definition.kind === kind
  );

  if (entry === undefined || entry.role !== "definition" || entry.definition.kind !== kind) {
    throw new Error(`missing definition ${kind}`);
  }

  return entry as Extract<BlockScheduleEntry, { role: "definition" }> &
    Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }>;
}

function boundaryEntry<TKind extends Extract<BlockScheduleEntry, { role: "boundary" }>["kind"]>(
  schedule: BlockSchedule,
  kind: TKind
): Extract<Extract<BlockScheduleEntry, { role: "boundary" }>, { kind: TKind }> {
  const entry = schedule.find((item) =>
    item.role === "boundary" && item.kind === kind
  );

  if (entry === undefined || entry.role !== "boundary" || entry.kind !== kind) {
    throw new Error(`missing boundary ${kind}`);
  }

  return entry as Extract<Extract<BlockScheduleEntry, { role: "boundary" }>, { kind: TKind }>;
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
