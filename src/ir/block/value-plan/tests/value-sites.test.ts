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
  rootsForBlockSites
} from "#ir/block/roots.js";
import type {
  BlockActionSite,
  BlockBoundarySite,
  BlockDefinitionSite,
  BlockTimeline,
  Placement
} from "#ir/block/timeline.js";
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
  producedValuesForDefinitions,
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
  const roots = rootsForBlockSites({ timeline: result.timeline });
  const sites = valueSitesForRoots(valueSiteInput(result.timeline, roots));

  strictEqual(sites.length, roots.filter((root) => root.purpose.kind !== "boundaryCell").length);
  deepStrictEqual(sites.map(siteSummary), [
    {
      kind: "actionInput",
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
  const root = rootsForBlockSites({ timeline: result.timeline }).find((candidate) =>
    candidate.purpose.kind === "actionInput" && candidate.purpose.input === "value"
  );

  if (root === undefined) {
    throw new Error("missing memory-store value root");
  }

  const sites = valueSitesForRoots(valueSiteInput(result.timeline, [root, root]));

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
  const changedBoundary = stateSyncSite(
    { opIndex: 10, epoch: 0 },
    BlockState.initial({
      registers: RegisterState.initial().write("eax", exprConst(0x11))
    })
  );
  const timeline = [
    ...memory.timeline,
    ...dynamic.timeline,
    ...branch.timeline,
    ...trap.timeline,
    ...fallthrough.timeline,
    changedBoundary
  ];
  const sites = valueSitesForRoots(valueSiteInput(timeline));

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
  const timeline = [
    stateSyncSite({ opIndex: 0, epoch: 0 }, BlockState.initial())
  ];

  deepStrictEqual(valueSitesForRoots(valueSiteInput(timeline)), []);
});

test("passthrough exit-state register and flag cells are skipped", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const boundaryRoots = rootsForBlockSites({ timeline: result.timeline }).filter((root) =>
    root.purpose.kind === "boundaryCell"
  );

  deepStrictEqual(valueSitesForRoots(valueSiteInput(result.timeline, boundaryRoots)), []);
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
  const timeline = [stateSyncSite({ opIndex: 4, epoch: 0 }, state)];
  const sites = valueSitesForRoots(valueSiteInput(timeline));

  deepStrictEqual(sites.map(siteSummary), [
    {
      kind: "boundaryCell",
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "reg", reg: "eax" }
    },
    {
      kind: "boundaryCell",
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "flag", flag: "CF" }
    }
  ]);
});

test("definition sites become ProducedValues without dependency fields", () => {
  const timeline = [
    memoryLoadSite({ opIndex: 0, epoch: 0 }, 0 as BlockDefinitionId),
    dynamicRegisterLoadSite({ opIndex: 1, epoch: 0 }, 1 as BlockDefinitionId)
  ];
  const produced = producedValuesForDefinitions({ definitions: timeline });

  deepStrictEqual(produced.map(producedSummary), [
    {
      id: timeline[0]!.definition.id,
      at: { opIndex: 0, epoch: 0 },
      definition: "memoryLoad"
    },
    {
      id: timeline[1]!.definition.id,
      at: { opIndex: 1, epoch: 0 },
      definition: "dynamicRegisterLoad"
    }
  ]);

  for (const value of produced) {
    deepStrictEqual(Object.keys(value), ["id", "at", "site"]);
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
  const timeline = [
    memoryLoadSite({ opIndex: 0, epoch: 0 }, id),
    memoryStoreSite({ opIndex: 1, epoch: 0 }, storeValue)
  ];
  const input = valueSiteInput(timeline);
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
  timeline: BlockTimeline,
  roots = rootsForBlockSites({ timeline })
): ValueSiteInput {
  return {
    graph: buildExprGraph(roots.map((root) => root.expr)),
    roots
  };
}

function stateSyncSite(
  at: Placement,
  state: BlockState
): BlockBoundarySite {
  return Object.freeze({
    kind: "boundary",
    at,
    boundary: Object.freeze({
      kind: "stateSync",
      state
    })
  });
}

function memoryLoadSite(
  at: Placement,
  id: BlockDefinitionId
): BlockDefinitionSite &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "memoryLoad" }> }> {
  return Object.freeze({
    kind: "definition",
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

function dynamicRegisterLoadSite(
  at: Placement,
  id: BlockDefinitionId
): BlockDefinitionSite &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }> }> {
  return Object.freeze({
    kind: "definition",
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

function memoryStoreSite(
  at: Placement,
  value: ExprRef
): BlockActionSite &
  Readonly<{ action: Extract<BlockAction, { kind: "memoryStore" }> }> {
  return Object.freeze({
    kind: "action",
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
  const site = sites.find((candidate) =>
    candidate.kind === "actionInput" &&
      candidate.site.action.kind === action &&
      candidate.input === input &&
      candidate.direction === direction
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
  const site = sites.find((candidate) =>
    candidate.kind === "definitionInput" &&
      candidate.site.definition.kind === definition &&
      candidate.input === input
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
  const site = sites.find((candidate) =>
    candidate.kind === "boundaryCell" &&
      candidate.boundary === boundary &&
      candidate.cell.kind === kind &&
      (candidate.cell.kind === "reg" ? candidate.cell.reg : candidate.cell.flag) === name
  );

  if (site === undefined || site.kind !== "boundaryCell") {
    throw new Error(`missing ${boundary} ${kind} ${name} boundary value site`);
  }

  return site;
}

function siteSummary(site: ValueSite): object {
  const base = {
    kind: site.kind,
    at: site.at
  };

  switch (site.kind) {
    case "actionInput":
      return {
        ...base,
        action: site.site.action.kind,
        input: site.input,
        ...(site.direction === undefined ? {} : { direction: site.direction })
      };
    case "definitionInput":
      return {
        ...base,
        definition: site.site.definition.kind,
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
    at: value.at,
    definition: value.site.definition.kind
  };
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
