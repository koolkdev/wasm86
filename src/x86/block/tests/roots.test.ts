import {
  deepStrictEqual,
  doesNotThrow,
  strictEqual,
  throws
} from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { BlockAction } from "#x86/block/actions.js";
import {
  definitionValueSource,
  type BlockDefinition,
  type BlockDefinitionId
} from "#x86/block/definitions.js";
import {
  rootsForSchedule,
  type BlockRoot
} from "#x86/block/roots.js";
import type {
  BlockSchedule,
  BlockScheduleEntry
} from "#x86/block/schedule.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#x86/block/bindings/resolver.js";
import {
  opSite,
  walkExpressionBlock
} from "#x86/block/walk/index.js";
import {
  exprConst,
  exprInput,
  exprUnary
} from "#x86/expr/builders.js";
import {
  bitsUse,
  full32Use
} from "#x86/expr/uses.js";
import type {
  ExprRef,
  ExprUse
} from "#x86/expr/types.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";

test("memory load definitions expose raw block-defined sources and signed uses stay explicit", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 8 },
      { op: "value.unary", type: "i32", operator: "extend8_s", dst: v(1), value: v(0) },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1), accessWidth: 32 }
    ]
  });
  const definition = onlyDefinition(result.schedule);

  strictEqual(definition.kind, "memoryLoad");
  strictEqual(definition.width, 8);
  deepStrictEqual(definition.result, { kind: "def", id: definition.id });
  strictEqual(Object.hasOwn(definition, "signed"), false);
  deepStrictEqual(
    result.final.registers.read("eax"),
    exprUnary("extend8_s", exprInput(definition.result))
  );
});

test("rootsForSchedule projects memory roots and closes over block-defined values", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 2, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 16 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 16 }
    ]
  });
  const roots = rootsForSchedule(result.schedule);
  const load = definitionEntry(result.schedule, "memoryLoad");
  const storeValue = actionRoot(roots, "memoryStore", "value");
  const closure = definitionRoot(roots, "memoryLoad", "address", "closure");

  deepStrictEqual(actionRoot(roots, "memoryGuard", "address").expr, exprConst(0x1000));
  deepStrictEqual(definitionRoot(roots, "memoryLoad", "address", "schedule").expr, exprConst(0x2000));
  deepStrictEqual(actionRoot(roots, "memoryStore", "address").expr, exprConst(0x3000));
  deepStrictEqual(storeValue.expr, exprInput(load.definition.result));
  deepStrictEqual(storeValue.use, bitsUse(0xffff));
  deepStrictEqual(closure.expr, exprConst(0x2000));
  deepStrictEqual(closure.at, load.at);
  deepStrictEqual(closure.purpose, {
    kind: "definitionInput",
    input: "address",
    source: "closure"
  });
});

test("rootsForSchedule projects dynamic register roots and producer indices", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(1), 32),
        dynamicRegBinding(exprConst(2), 32)
      ]
    })
  });
  const roots = rootsForSchedule(result.schedule);
  const load = definitionEntry(result.schedule, "dynamicRegisterLoad");

  deepStrictEqual(definitionRoot(roots, "dynamicRegisterLoad", "index", "schedule").expr, exprConst(1));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "index").expr, exprConst(2));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "value").expr, exprInput(load.definition.result));
  deepStrictEqual(actionRoot(roots, "dynamicRegisterStore", "value").use, bitsUse(0xffff_ffff));
  deepStrictEqual(definitionRoot(roots, "dynamicRegisterLoad", "index", "closure").purpose, {
    kind: "definitionInput",
    input: "index",
    source: "closure"
  });
});

test("rootsForSchedule projects branch, jump, fallthrough, and host trap roots", () => {
  const branch = rootsForSchedule(walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ],
    continuation: exprConst(0x48)
  }).schedule);
  const jump = rootsForSchedule(walkExpressionBlock({
    block: [
      { op: "jump", target: c(0x80) }
    ]
  }).schedule);
  const trap = rootsForSchedule(walkExpressionBlock({
    block: [
      { op: "hostTrap", vector: c(7) }
    ]
  }).schedule);
  const fallthrough = rootsForSchedule(walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  }).schedule);

  deepStrictEqual(actionRoot(branch, "branch", "condition").expr, exprConst(1));
  deepStrictEqual(
    [
      actionRoot(branch, "branch", "target", "taken").expr,
      actionRoot(branch, "branch", "target", "notTaken").expr
    ],
    [exprConst(0x40), exprConst(0x44)]
  );
  deepStrictEqual(actionRoot(jump, "jump", "target").expr, exprConst(0x80));
  deepStrictEqual(actionRoot(fallthrough, "fallthrough", "target").expr, exprConst(0x90));
  deepStrictEqual(actionRoot(trap, "hostTrap", "vector").expr, exprConst(7));
});

test("rootsForSchedule projects boundary state roots from scheduled boundaries", () => {
  const exitResult = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "flags.write", cells: { ZF: { kind: "expr", value: c(1) } } },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const syncResult = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const roots = rootsForSchedule([
    ...exitResult.schedule,
    ...syncResult.schedule
  ]);

  deepStrictEqual(boundaryRegister(roots, "exitState", "eax")?.expr, exprConst(0x11));
  deepStrictEqual(boundaryFlag(roots, "exitState", "ZF")?.expr, exprConst(1));
  deepStrictEqual(boundaryRegister(roots, "stateSync", "esp")?.expr, exprConst(0x44));
  deepStrictEqual(boundaryFlag(roots, "exitState", "ZF")?.use, bitsUse(1));
  deepStrictEqual(boundaryRegister(roots, "exitState", "eax")?.use, full32Use());
});

test("rootsForSchedule validates block-defined value ordering and missing producers", () => {
  const id = 0 as BlockDefinitionId;
  const source = definitionValueSource(id);
  const definition = memoryLoadDefinition(id, exprConst(0x2000), 32);
  const storeBeforeDefinition = actionEntry(0, {
    kind: "memoryStore",
    at: opSite(0),
    address: exprConst(0x3000),
    value: exprInput(source),
    width: 32
  });
  const storeAfterDefinition = actionEntry(2, {
    ...storeBeforeDefinition.action,
    at: opSite(2)
  });
  const definitionScheduleEntry = definitionEntryFromDefinition(definition, 1);

  throws(
    () => rootsForSchedule([storeBeforeDefinition, definitionScheduleEntry]),
    /observed before its definition placement/
  );
  throws(
    () => rootsForSchedule([storeBeforeDefinition]),
    /not present in the schedule/
  );
  doesNotThrow(
    () => rootsForSchedule([definitionScheduleEntry, storeAfterDefinition])
  );
});

test("root projection remains block-owned and independent of target modules", () => {
  const source = readFileSync(new URL("../roots.js", import.meta.url), "utf8");

  strictEqual(source.includes("#backends/"), false);
  strictEqual(source.includes("interpreter"), false);
  strictEqual(source.includes("walkExpressionBlock"), false);
});

function onlyDefinition(schedule: BlockSchedule): BlockDefinition {
  const definitions = schedule.flatMap((entry) =>
    entry.role === "definition" ? [entry.definition] : []
  );

  strictEqual(definitions.length, 1);
  return definitions[0]!;
}

function actionRoot(
  roots: readonly BlockRoot[],
  kind: BlockAction["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "actionInput" }>["input"],
  direction?: "taken" | "notTaken"
): BlockRoot {
  const root = roots.find((entry) =>
    entry.entry.role === "action" &&
      entry.entry.action.kind === kind &&
      entry.purpose.kind === "actionInput" &&
      entry.purpose.input === input &&
      entry.purpose.direction === direction
  );

  if (root === undefined) {
    throw new Error(`missing ${kind} ${input} root`);
  }

  return root;
}

function definitionRoot<TKind extends BlockDefinition["kind"]>(
  roots: readonly BlockRoot[],
  kind: TKind,
  input: Extract<BlockRoot["purpose"], { kind: "definitionInput" }>["input"],
  source: Extract<BlockRoot["purpose"], { kind: "definitionInput" }>["source"]
): BlockRoot {
  const root = roots.find((entry) =>
    entry.entry.role === "definition" &&
      entry.entry.definition.kind === kind &&
      entry.purpose.kind === "definitionInput" &&
      entry.purpose.input === input &&
      entry.purpose.source === source
  );

  if (root === undefined) {
    throw new Error(`missing ${kind} ${input} ${source} root`);
  }

  return root;
}

function boundaryRegister(
  roots: readonly BlockRoot[],
  boundary: "exitState" | "stateSync",
  reg: string
): Readonly<{ expr: ExprRef; use: ExprUse }> | undefined {
  return roots.find((root) =>
    root.entry.role === "boundary" &&
      root.entry.kind === boundary &&
      root.purpose.kind === "boundaryCell" &&
      root.purpose.cell.kind === "reg" &&
      root.purpose.cell.reg === reg
  );
}

function boundaryFlag(
  roots: readonly BlockRoot[],
  boundary: "exitState" | "stateSync",
  flag: string
): Readonly<{ expr: ExprRef; use: ExprUse }> | undefined {
  return roots.find((root) =>
    root.entry.role === "boundary" &&
      root.entry.kind === boundary &&
      root.purpose.kind === "boundaryCell" &&
      root.purpose.cell.kind === "flag" &&
      root.purpose.cell.flag === flag
  );
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

function actionEntry(opIndex: number, action: BlockAction): Extract<BlockScheduleEntry, { role: "action" }> {
  return Object.freeze({
    role: "action",
    at: Object.freeze({ opIndex, epoch: 0 }),
    action
  });
}

function definitionEntryFromDefinition(
  definition: BlockDefinition,
  opIndex: number
): Extract<BlockScheduleEntry, { role: "definition" }> {
  return Object.freeze({
    role: "definition",
    at: Object.freeze({ opIndex, epoch: 0 }),
    definition
  });
}

function memoryLoadDefinition(
  id: BlockDefinitionId,
  address: ExprRef,
  width: 32
): BlockDefinition {
  return Object.freeze({
    kind: "memoryLoad",
    id,
    at: opSite(1),
    result: definitionValueSource(id),
    address,
    width
  });
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
