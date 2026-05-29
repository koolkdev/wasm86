import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import {
  type BlockDefinition,
  type BlockDefinitionId
} from "#ir/block/definitions.js";
import {
  rootsForSchedule
} from "#ir/block/roots.js";
import type {
  BlockSchedule,
  BlockScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import { FlagState } from "#ir/block/state/flag-state.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import { BlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import { buildExprGraph } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  producedValuesForSchedule,
  type ProducedValue
} from "#ir/block/value-plan/produced-values.js";
import {
  valueSitesForRoots,
  type ValueSite,
  type ValueSiteInput
} from "#ir/block/value-plan/value-sites.js";

test("every non-passthrough root becomes one value site", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const roots = rootsForSchedule(result.schedule);
  const sites = valueSitesForRoots(valueSiteInput(result.schedule, roots));

  strictEqual(sites.length, roots.filter((root) => root.purpose.kind !== "boundaryCell").length);
  deepStrictEqual(sites.map(siteSummary), [
    {
      kind: "actionInput",
      order: 0,
      at: { opIndex: 0, epoch: 0 },
      action: "memoryGuard",
      input: "address"
    }
  ]);
});

test("duplicate roots remain duplicate value sites", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "mem", address: c(0x1000) }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const root = rootsForSchedule(result.schedule).find((entry) =>
    entry.purpose.kind === "actionInput" && entry.purpose.input === "value"
  );

  if (root === undefined) {
    throw new Error("missing memory-store value root");
  }

  const sites = valueSitesForRoots(valueSiteInput(result.schedule, [root, root]));

  strictEqual(sites.length, 2);
  strictEqual(sites[0]?.root, root);
  strictEqual(sites[1]?.root, root);
  strictEqual(sites[0]?.key, sites[1]?.key);
});

test("root purpose maps to the correct site variant", () => {
  const memory = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
    ]
  });
  const dynamic = walkExpressionBlock({
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
  const branch = walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const trap = walkExpressionBlock({
    block: [
      { op: "hostTrap", vector: c(7) }
    ]
  });
  const fallthrough = walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  });
  const changedBoundary = stateSyncEntry(
    { opIndex: 10, epoch: 0 },
    BlockState.initial({
      registers: RegisterState.initial().write("eax", exprConst(0x11))
    })
  );
  const schedule = [
    ...memory.schedule,
    ...dynamic.schedule,
    ...branch.schedule,
    ...trap.schedule,
    ...fallthrough.schedule,
    changedBoundary
  ];
  const sites = valueSitesForRoots(valueSiteInput(schedule));

  requireActionSite(sites, "memoryGuard", "address");
  requireDefinitionSite(sites, "memoryLoad", "address");
  requireActionSite(sites, "memoryStore", "address");
  requireActionSite(sites, "memoryStore", "value");
  requireDefinitionSite(sites, "dynamicRegisterLoad", "index");
  requireActionSite(sites, "dynamicRegisterStore", "index");
  requireActionSite(sites, "dynamicRegisterStore", "value");
  requireActionSite(sites, "branch", "condition");
  requireActionSite(sites, "branch", "target", "taken");
  requireActionSite(sites, "branch", "target", "notTaken");
  requireActionSite(sites, "hostTrap", "vector");
  requireActionSite(sites, "fallthrough", "target");
  requireBoundarySite(sites, "stateSync", "reg", "eax");
});

test("passthrough state-sync register and flag cells are skipped", () => {
  const schedule = [
    stateSyncEntry({ opIndex: 0, epoch: 0 }, BlockState.initial())
  ];

  deepStrictEqual(valueSitesForRoots(valueSiteInput(schedule)), []);
});

test("passthrough exit-state register and flag cells are skipped", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const boundaryRoots = rootsForSchedule(result.schedule).filter((root) =>
    root.purpose.kind === "boundaryCell"
  );

  deepStrictEqual(valueSitesForRoots(valueSiteInput(result.schedule, boundaryRoots)), []);
});

test("changed boundary cells become BoundaryCellValueSites", () => {
  const state = BlockState.initial({
    registers: RegisterState.initial().write(
      "eax",
      exprBinary("add", exprInput({ kind: "reg", reg: "eax" }), exprConst(1))
    ),
    flags: FlagState.initial().apply({
      cells: { CF: { kind: "expr", value: exprConst(1) } }
    })
  });
  const schedule = [stateSyncEntry({ opIndex: 4, epoch: 0 }, state)];
  const sites = valueSitesForRoots(valueSiteInput(schedule));

  deepStrictEqual(sites.map(siteSummary), [
    {
      kind: "boundaryCell",
      order: 0,
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "reg", reg: "eax" }
    },
    {
      kind: "boundaryCell",
      order: 0,
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "flag", flag: "CF" }
    }
  ]);
});

test("definition entries become ProducedValues without dependency fields", () => {
  const schedule = [
    memoryLoadEntry({ opIndex: 0, epoch: 0 }, 0 as BlockDefinitionId),
    dynamicRegisterLoadEntry({ opIndex: 1, epoch: 0 }, 1 as BlockDefinitionId)
  ];
  const produced = producedValuesForSchedule({ schedule });

  deepStrictEqual(produced.map(producedSummary), [
    {
      id: schedule[0]!.definition.id,
      order: 0,
      at: { opIndex: 0, epoch: 0 },
      definition: "memoryLoad"
    },
    {
      id: schedule[1]!.definition.id,
      order: 1,
      at: { opIndex: 1, epoch: 0 },
      definition: "dynamicRegisterLoad"
    }
  ]);

  for (const value of produced) {
    deepStrictEqual(Object.keys(value), ["id", "order", "at", "entry"]);
    strictEqual(Object.hasOwn(value, "key"), false);
    strictEqual(Object.hasOwn(value, "expr"), false);
    strictEqual(Object.hasOwn(value, "sourceCells"), false);
    strictEqual(Object.hasOwn(value, "definitionIds"), false);
    strictEqual(Object.hasOwn(value, "deps"), false);
  }
});

test("value sites carry ExprDeps", () => {
  const id = 3 as BlockDefinitionId;
  const storeValue = exprBinary(
    "add",
    exprInput({ kind: "def", id }),
    exprInput({ kind: "reg", reg: "eax" })
  );
  const schedule = [
    memoryLoadEntry({ opIndex: 0, epoch: 0 }, id),
    memoryStoreEntry({ opIndex: 1, epoch: 0 }, storeValue)
  ];
  const input = valueSiteInput(schedule);
  const site = requireActionSite(
    valueSitesForRoots(input),
    "memoryStore",
    "value"
  );

  deepStrictEqual(site.deps.definitionIds, [id]);
  deepStrictEqual(site.deps.sourceCells, [
    { kind: "reg", reg: registerAlias("eax") }
  ]);
  strictEqual(site.key, input.graph.node(site.expr).id);
});

function valueSiteInput(
  schedule: BlockSchedule,
  roots = rootsForSchedule(schedule)
): ValueSiteInput {
  return {
    schedule,
    graph: buildExprGraph(roots.map((root) => root.expr)),
    roots
  };
}

function stateSyncEntry(
  at: Placement,
  state: BlockState
): Extract<BlockScheduleEntry, { role: "boundary"; kind: "stateSync" }> {
  return Object.freeze({
    role: "boundary",
    kind: "stateSync",
    at,
    state
  });
}

function memoryLoadEntry(
  at: Placement,
  id: BlockDefinitionId
): Extract<BlockScheduleEntry, { role: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "memoryLoad" }> }> {
  return Object.freeze({
    role: "definition",
    at,
    definition: Object.freeze({
      kind: "memoryLoad",
      id,
      at: opSite(at.opIndex),
      result: { kind: "def", id },
      address: exprConst(0x1000),
      width: 32
    } satisfies Extract<BlockDefinition, { kind: "memoryLoad" }>)
  });
}

function dynamicRegisterLoadEntry(
  at: Placement,
  id: BlockDefinitionId
): Extract<BlockScheduleEntry, { role: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }> }> {
  return Object.freeze({
    role: "definition",
    at,
    definition: Object.freeze({
      kind: "dynamicRegisterLoad",
      id,
      at: opSite(at.opIndex),
      result: { kind: "def", id },
      index: exprConst(1),
      width: 32
    } satisfies Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }>)
  });
}

function memoryStoreEntry(
  at: Placement,
  value: ExprRef
): Extract<BlockScheduleEntry, { role: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: "memoryStore" }> }> {
  return Object.freeze({
    role: "action",
    at,
    action: Object.freeze({
      kind: "memoryStore",
      at: opSite(at.opIndex),
      address: exprConst(0x2000),
      value,
      width: 32
    } satisfies Extract<BlockAction, { kind: "memoryStore" }>)
  });
}

function requireActionSite(
  sites: readonly ValueSite[],
  action: BlockAction["kind"],
  input: Extract<ValueSite, { kind: "actionInput" }>["input"],
  direction?: "taken" | "notTaken"
): Extract<ValueSite, { kind: "actionInput" }> {
  const site = sites.find((entry) =>
    entry.kind === "actionInput" &&
      entry.entry.action.kind === action &&
      entry.input === input &&
      entry.direction === direction
  );

  if (site === undefined || site.kind !== "actionInput") {
    throw new Error(`missing ${action} ${input} action value site`);
  }

  return site;
}

function requireDefinitionSite(
  sites: readonly ValueSite[],
  definition: BlockDefinition["kind"],
  input: Extract<ValueSite, { kind: "definitionInput" }>["input"]
): Extract<ValueSite, { kind: "definitionInput" }> {
  const site = sites.find((entry) =>
    entry.kind === "definitionInput" &&
      entry.entry.definition.kind === definition &&
      entry.input === input
  );

  if (site === undefined || site.kind !== "definitionInput") {
    throw new Error(`missing ${definition} ${input} definition value site`);
  }

  return site;
}

function requireBoundarySite(
  sites: readonly ValueSite[],
  boundary: "stateSync" | "exitState",
  kind: "reg" | "flag",
  name: string
): Extract<ValueSite, { kind: "boundaryCell" }> {
  const site = sites.find((entry) =>
    entry.kind === "boundaryCell" &&
      entry.boundary === boundary &&
      entry.cell.kind === kind &&
      (entry.cell.kind === "reg" ? entry.cell.reg : entry.cell.flag) === name
  );

  if (site === undefined || site.kind !== "boundaryCell") {
    throw new Error(`missing ${boundary} ${kind} ${name} boundary value site`);
  }

  return site;
}

function siteSummary(site: ValueSite): object {
  const base = {
    kind: site.kind,
    order: site.order,
    at: site.at
  };

  switch (site.kind) {
    case "actionInput":
      return {
        ...base,
        action: site.entry.action.kind,
        input: site.input,
        ...(site.direction === undefined ? {} : { direction: site.direction })
      };
    case "definitionInput":
      return {
        ...base,
        definition: site.entry.definition.kind,
        input: site.input
      };
    case "boundaryCell":
      return {
        ...base,
        boundary: site.boundary,
        cell: site.cell
      };
  }
}

function producedSummary(value: ProducedValue): object {
  return {
    id: value.id,
    order: value.order,
    at: value.at,
    definition: value.entry.definition.kind
  };
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
