import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#x86/block/bindings/resolver.js";
import type { BlockAction } from "#x86/block/actions.js";
import type { BlockDefinition } from "#x86/block/definitions.js";
import {
  type BoundaryScheduleEntry,
  type BlockScheduleEntry,
  walkExpressionBlock
} from "#x86/block/walk/index.js";
import {
  exprConst,
  exprInput
} from "#x86/expr/builders.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";

test("block schedule preserves walk action and definition order", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "memory.guard", address: c(0x2000), byteLength: 4, access: "write" },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: v(0), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x3000)
  });
  const schedule = result.schedule;

  deepStrictEqual(schedule.map(scheduleKind), [
    "memoryGuard",
    "exitState",
    "memoryLoad",
    "memoryGuard",
    "exitState",
    "memoryStore",
    "fallthrough",
    "exitState"
  ]);
  deepStrictEqual(schedule.map((entry) => entry.role), [
    "action",
    "boundary",
    "definition",
    "action",
    "boundary",
    "action",
    "action",
    "boundary"
  ]);
  deepStrictEqual(schedule.map((entry) => entry.at), [
    { opIndex: 0, epoch: 0 },
    { opIndex: 0, epoch: 0 },
    { opIndex: 1, epoch: 0 },
    { opIndex: 2, epoch: 0 },
    { opIndex: 2, epoch: 0 },
    { opIndex: 3, epoch: 0 },
    { opIndex: 4, epoch: 0 },
    { opIndex: 4, epoch: 0 }
  ]);
});

test("block schedule keeps memory load definitions distinct from memory stores", () => {
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 16 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: v(0), accessWidth: 16 }
    ]
  });
  const schedule = result.schedule;
  const load = requireDefinitionEntry(schedule[0], "memoryLoad");
  const store = requireActionEntry(schedule[1], "memoryStore");

  strictEqual(load.role, "definition");
  strictEqual(store.role, "action");
  strictEqual(load.definition.kind, "memoryLoad");
  deepStrictEqual(load.definition.address, exprConst(0x1000));
  strictEqual(load.definition.width, 16);
  strictEqual(store.action.kind, "memoryStore");
  deepStrictEqual(store.action.address, exprConst(0x2000));
  deepStrictEqual(store.action.value, exprInput(load.definition.result));
  strictEqual(store.action.width, 16);
});

test("block schedule carries branch and fallthrough exits", () => {
  const branchResult = walkExpressionBlock({
    block: [
      { op: "value.compare", type: "i32", operator: "eq", width: 32, dst: v(0), a: c(1), b: c(2) },
      { op: "conditionalJump", condition: v(0), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const branch = requireActionEntry(branchResult.schedule[0], "branch");
  const takenBoundary = requireBoundaryEntry(branchResult.schedule[1], "exitState");
  const notTakenBoundary = requireBoundaryEntry(branchResult.schedule[2], "exitState");

  strictEqual(branch.role, "action");
  strictEqual(branch.action.kind, "branch");
  strictEqual(branch.action.taken.kind, "branchTaken");
  strictEqual(branch.action.notTaken.kind, "branchNotTaken");
  deepStrictEqual(branch.action.taken.payload, {
    kind: "branch",
    direction: "taken",
    target: exprConst(0x40)
  });
  deepStrictEqual(branch.action.notTaken.payload, {
    kind: "branch",
    direction: "notTaken"
  });
  strictEqual(takenBoundary.exit, branch.action.taken);
  strictEqual(takenBoundary.state, branch.action.taken.snapshot);
  strictEqual(takenBoundary.at, branch.at);
  strictEqual(notTakenBoundary.exit, branch.action.notTaken);
  strictEqual(notTakenBoundary.state, branch.action.notTaken.snapshot);
  strictEqual(notTakenBoundary.at, branch.at);

  const fallthroughResult = walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const fallthrough = requireActionEntry(fallthroughResult.schedule[0], "fallthrough");
  const boundary = requireBoundaryEntry(fallthroughResult.schedule[1], "exitState");

  strictEqual(fallthrough.action.kind, "fallthrough");
  strictEqual(fallthrough.action.exit.kind, "fallthrough");
  deepStrictEqual(fallthrough.action.continuation, {
    kind: "continuation",
    value: exprConst(0x80)
  });
  strictEqual(boundary.exit, fallthrough.action.exit);
  strictEqual(boundary.state, fallthrough.action.exit.snapshot);
  strictEqual(boundary.at, fallthrough.at);
});

test("exit-producing actions append exitState boundaries from their snapshots", () => {
  const memoryFault = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const guard = requireActionEntry(memoryFault.schedule[0], "memoryGuard");
  const guardBoundary = requireBoundaryEntry(memoryFault.schedule[1], "exitState");

  strictEqual(guardBoundary.exit, guard.action.faultExit);
  strictEqual(guardBoundary.state, guard.action.faultExit.snapshot);
  strictEqual(guardBoundary.at, guard.at);
  deepStrictEqual(guardBoundary.state.registers.read("eax"), exprConst(0x11));

  const jumpResult = walkExpressionBlock({
    block: [
      { op: "jump", target: c(0x40) }
    ]
  });
  const jump = requireActionEntry(jumpResult.schedule[0], "jump");
  const jumpBoundary = requireBoundaryEntry(jumpResult.schedule[1], "exitState");

  strictEqual(jumpBoundary.exit, jump.action.exit);
  strictEqual(jumpBoundary.state, jump.action.exit.snapshot);
  strictEqual(jumpBoundary.at, jump.at);
});

test("block schedule includes dynamic register definitions and actions", () => {
  const result = walkFragment({
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
  const schedule = result.schedule;
  const load = requireDefinitionEntry(schedule[0], "dynamicRegisterLoad");
  const store = requireActionEntry(schedule[1], "dynamicRegisterStore");

  strictEqual(load.role, "definition");
  strictEqual(store.role, "action");
  strictEqual(load.definition.kind, "dynamicRegisterLoad");
  deepStrictEqual(load.definition.index, exprConst(1));
  strictEqual(load.definition.width, 32);
  strictEqual(store.action.kind, "dynamicRegisterStore");
  deepStrictEqual(store.action.index, exprConst(2));
  deepStrictEqual(store.action.value, exprInput(load.definition.result));
});

test("no-explicit-exit blocks expose final state only through walk.final", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x55), accessWidth: 32 }
    ]
  });

  deepStrictEqual(result.schedule, []);
  deepStrictEqual(result.final.registers.read("eax"), exprConst(0x55));
});

test("dynamic register stores sync prior static register state before the runtime store", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const sync = requireBoundaryEntry(result.schedule[0], "stateSync");
  const store = requireActionEntry(result.schedule[1], "dynamicRegisterStore");

  deepStrictEqual(sync.at, { opIndex: 1, epoch: 0 });
  deepStrictEqual(store.at, { opIndex: 1, epoch: 1 });
  deepStrictEqual(sync.state.registers.read("esp"), exprConst(0x44));
  strictEqual(store.action.kind, "dynamicRegisterStore");
});

test("boundary entries carry state snapshots without concrete write plans or backend policy", () => {
  const result = walkFragment({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const dynamicStore = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const boundaries = [
    ...boundaryEntries(result.schedule),
    ...boundaryEntries(dynamicStore.schedule)
  ];

  deepStrictEqual(boundaries.map((entry) => entry.kind), ["exitState", "stateSync"]);
  deepStrictEqual(Object.keys(boundaries[0]!), ["role", "kind", "at", "exit", "state"]);
  deepStrictEqual(Object.keys(boundaries[1]!), ["role", "kind", "at", "state"]);
  deepStrictEqual(disallowedBoundaryKeys(boundaries), []);
});

test("block schedule placements are stable anchors without Wasm local mechanics", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "jump", target: c(0x40) }
    ]
  });
  const schedule = result.schedule;
  const nonExitBoundaryPlacements = schedule.filter((entry) =>
    entry.role !== "boundary" || entry.kind !== "exitState"
  );

  strictEqual(
    new Set(nonExitBoundaryPlacements.map((entry) => `${entry.at.opIndex}:${entry.at.epoch}`)).size,
    nonExitBoundaryPlacements.length
  );
  deepStrictEqual(disallowedWasmKeys(schedule), []);
});

function scheduleKind(
  entry: BlockScheduleEntry
): BlockAction["kind"] | BlockDefinition["kind"] | BoundaryScheduleEntry["kind"] {
  switch (entry.role) {
    case "action":
      return entry.action.kind;
    case "definition":
      return entry.definition.kind;
    case "boundary":
      return entry.kind;
  }
}

function requireActionEntry<TKind extends BlockAction["kind"]>(
  entry: BlockScheduleEntry | undefined,
  kind: TKind
): ActionEntryFor<TKind> {
  strictEqual(entry?.role, "action");
  const actionEntry = entry as ActionEntryFor<TKind>;

  strictEqual(actionEntry.action.kind, kind);
  return actionEntry;
}

function requireDefinitionEntry<TKind extends BlockDefinition["kind"]>(
  entry: BlockScheduleEntry | undefined,
  kind: TKind
): DefinitionEntryFor<TKind> {
  strictEqual(entry?.role, "definition");
  const definitionEntry = entry as DefinitionEntryFor<TKind>;

  strictEqual(definitionEntry.definition.kind, kind);
  return definitionEntry;
}

function requireBoundaryEntry<TKind extends BoundaryScheduleEntry["kind"]>(
  entry: BlockScheduleEntry | undefined,
  kind: TKind
): BoundaryEntryFor<TKind> {
  strictEqual(entry?.role, "boundary");
  const boundaryEntry = entry as BoundaryEntryFor<TKind>;

  strictEqual(boundaryEntry.kind, kind);
  return boundaryEntry;
}

function walkFragment(
  input: Parameters<typeof walkExpressionBlock>[0]
): ReturnType<typeof walkExpressionBlock> {
  return walkExpressionBlock(input);
}

function boundaryEntries(schedule: readonly BlockScheduleEntry[]): readonly BoundaryScheduleEntry[] {
  return schedule.flatMap((entry) => entry.role === "boundary" ? [entry] : []);
}

type ActionEntryFor<TKind extends BlockAction["kind"]> =
  Extract<BlockScheduleEntry, { role: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: TKind }> }>;

type DefinitionEntryFor<TKind extends BlockDefinition["kind"]> =
  Extract<BlockScheduleEntry, { role: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }>;

type BoundaryEntryFor<TKind extends BoundaryScheduleEntry["kind"]> =
  Extract<BoundaryScheduleEntry, { kind: TKind }>;

function disallowedWasmKeys(value: unknown): readonly string[] {
  const disallowed = new Set([
    "local",
    "localIndex",
    "localGet",
    "localSet",
    "localTee",
    "tee"
  ]);
  const seen = new Set<object>();
  const found = new Set<string>();

  collectDisallowedKeys(value, disallowed, seen, found);
  return [...found].sort();
}

function disallowedBoundaryKeys(value: unknown): readonly string[] {
  const disallowed = new Set([
    "cellsToWrite",
    "writes",
    "stores",
    "stateOffset",
    "stateMemoryOffset",
    "cpuStateOffset",
    "local",
    "localIndex",
    "localGet",
    "localSet",
    "localTee",
    "jitPolicy",
    "interpreterPolicy",
    "fallbackPolicy"
  ]);
  const seen = new Set<object>();
  const found = new Set<string>();

  collectDisallowedKeys(value, disallowed, seen, found);
  return [...found].sort();
}

function collectDisallowedKeys(
  value: unknown,
  disallowed: ReadonlySet<string>,
  seen: Set<object>,
  found: Set<string>
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (disallowed.has(key)) {
      found.add(key);
    }

    collectDisallowedKeys(child, disallowed, seen, found);
  }
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
