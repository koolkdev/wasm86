import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import {
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  actionSites,
  boundarySites,
  definitionSites,
  type BlockBoundarySite,
  type BlockTimelineSite
} from "#ir/block/timeline.js";
import {
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("block timeline preserves walk action, definition, and boundary order", () => {
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
  const timeline = result.timeline;

  deepStrictEqual(timeline.map(timelineSiteKind), [
    "memoryGuard",
    "exitState",
    "memoryLoad",
    "memoryGuard",
    "exitState",
    "memoryStore",
    "fallthrough",
    "exitState"
  ]);
  deepStrictEqual(timeline.map((site) => site.kind), [
    "action",
    "boundary",
    "definition",
    "action",
    "boundary",
    "action",
    "action",
    "boundary"
  ]);
  deepStrictEqual(timeline.map((site) => site.at), [
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

test("typed timeline selectors preserve order and separate site categories", () => {
  const result = walkFragment({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x4000)
  });

  deepStrictEqual(actionSites(result.timeline).map((site) => site.action.kind), [
    "memoryGuard",
    "memoryStore",
    "fallthrough"
  ]);
  deepStrictEqual(definitionSites(result.timeline).map((site) => site.definition.kind), [
    "memoryLoad"
  ]);
  deepStrictEqual(boundarySites(result.timeline).map((site) => site.boundary.kind), [
    "exitState",
    "exitState"
  ]);
});

test("block timeline keeps memory load definitions distinct from memory stores", () => {
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 16 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: v(0), accessWidth: 16 }
    ]
  });
  const timeline = result.timeline;
  const load = requireDefinitionSite(timeline[0], "memoryLoad");
  const store = requireActionSite(timeline[1], "memoryStore");

  strictEqual(load.kind, "definition");
  strictEqual(store.kind, "action");
  strictEqual(load.definition.kind, "memoryLoad");
  deepStrictEqual(load.definition.address, exprConst(0x1000));
  strictEqual(load.definition.width, 16);
  strictEqual(store.action.kind, "memoryStore");
  deepStrictEqual(store.action.address, exprConst(0x2000));
  deepStrictEqual(store.action.value, exprInput(load.definition.result));
  strictEqual(store.action.width, 16);
});

test("block timeline carries branch and fallthrough exits", () => {
  const branchResult = walkExpressionBlock({
    block: [
      { op: "value.compare", type: "i32", operator: "eq", width: 32, dst: v(0), a: c(1), b: c(2) },
      { op: "conditionalJump", condition: v(0), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const branch = requireActionSite(branchResult.timeline[0], "branch");
  const takenBoundary = requireBoundarySite(branchResult.timeline[1], "exitState");
  const notTakenBoundary = requireBoundarySite(branchResult.timeline[2], "exitState");

  strictEqual(branch.kind, "action");
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
  strictEqual(takenBoundary.boundary.exit, branch.action.taken);
  strictEqual(takenBoundary.boundary.state, branch.action.taken.snapshot);
  strictEqual(takenBoundary.at, branch.at);
  strictEqual(notTakenBoundary.boundary.exit, branch.action.notTaken);
  strictEqual(notTakenBoundary.boundary.state, branch.action.notTaken.snapshot);
  strictEqual(notTakenBoundary.at, branch.at);

  const fallthroughResult = walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const fallthrough = requireActionSite(fallthroughResult.timeline[0], "fallthrough");
  const boundary = requireBoundarySite(fallthroughResult.timeline[1], "exitState");

  strictEqual(fallthrough.action.kind, "fallthrough");
  strictEqual(fallthrough.action.exit.kind, "fallthrough");
  deepStrictEqual(fallthrough.action.continuation, {
    kind: "continuation",
    value: exprConst(0x80)
  });
  strictEqual(boundary.boundary.exit, fallthrough.action.exit);
  strictEqual(boundary.boundary.state, fallthrough.action.exit.snapshot);
  strictEqual(boundary.at, fallthrough.at);
});

test("exit-producing actions append exitState boundaries from their snapshots", () => {
  const memoryFault = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const guard = requireActionSite(memoryFault.timeline[0], "memoryGuard");
  const guardBoundary = requireBoundarySite(memoryFault.timeline[1], "exitState");

  strictEqual(guardBoundary.boundary.exit, guard.action.faultExit);
  strictEqual(guardBoundary.boundary.state, guard.action.faultExit.snapshot);
  strictEqual(guardBoundary.at, guard.at);
  deepStrictEqual(guardBoundary.boundary.state.registers.read("eax"), exprConst(0x11));

  const jumpResult = walkExpressionBlock({
    block: [
      { op: "jump", target: c(0x40) }
    ]
  });
  const jump = requireActionSite(jumpResult.timeline[0], "jump");
  const jumpBoundary = requireBoundarySite(jumpResult.timeline[1], "exitState");

  strictEqual(jumpBoundary.boundary.exit, jump.action.exit);
  strictEqual(jumpBoundary.boundary.state, jump.action.exit.snapshot);
  strictEqual(jumpBoundary.at, jump.at);
});

test("block timeline includes dynamic register definitions and actions", () => {
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
  const timeline = result.timeline;
  const load = requireDefinitionSite(timeline[0], "dynamicRegisterLoad");
  const store = requireActionSite(timeline[1], "dynamicRegisterStore");

  strictEqual(load.kind, "definition");
  strictEqual(store.kind, "action");
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

  deepStrictEqual(result.timeline, []);
  deepStrictEqual(result.final.registers.read("eax"), exprConst(0x55));
});

test("dynamic register stores sync prior static register state before the dynamic store", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const sync = requireBoundarySite(result.timeline[0], "stateSync");
  const store = requireActionSite(result.timeline[1], "dynamicRegisterStore");

  deepStrictEqual(sync.at, { opIndex: 1, epoch: 0 });
  deepStrictEqual(store.at, { opIndex: 1, epoch: 1 });
  deepStrictEqual(sync.boundary.state.registers.read("esp"), exprConst(0x44));
  strictEqual(store.action.kind, "dynamicRegisterStore");
});

test("dynamic register stores reset later boundary register state", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "flags.write", cells: { ZF: { kind: "expr", value: c(1) } } },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
      { op: "next" }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  requireBoundarySite(result.timeline[0], "stateSync");
  const store = requireActionSite(result.timeline[1], "dynamicRegisterStore");
  const fallthrough = requireActionSite(result.timeline[2], "fallthrough");
  const exit = requireBoundarySite(result.timeline[3], "exitState");

  strictEqual(store.action.kind, "dynamicRegisterStore");
  strictEqual(fallthrough.action.kind, "fallthrough");
  deepStrictEqual(exit.boundary.state.registers.read("esp"), exprInput({ kind: "reg", reg: "esp" }));
});

test("dynamic register stores without preceding sync keep later register state reset", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
      { op: "next" }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const store = requireActionSite(result.timeline[0], "dynamicRegisterStore");
  const exit = requireBoundarySite(result.timeline[2], "exitState");

  deepStrictEqual(result.timeline.map(timelineSiteKind), [
    "dynamicRegisterStore",
    "fallthrough",
    "exitState"
  ]);
  strictEqual(store.action.kind, "dynamicRegisterStore");
  deepStrictEqual(exit.boundary.state.registers.read("esp"), exprInput({ kind: "reg", reg: "esp" }));
});

test("boundary sites carry state snapshots without concrete write plans or backend policy", () => {
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
    ...boundarySitesOnly(result.timeline),
    ...boundarySitesOnly(dynamicStore.timeline)
  ];

  deepStrictEqual(boundaries.map((site) => site.boundary.kind), ["exitState", "stateSync"]);
  deepStrictEqual(Object.keys(boundaries[0]!), ["kind", "at", "boundary"]);
  deepStrictEqual(Object.keys(boundaries[0]!.boundary), ["kind", "exit", "state"]);
  deepStrictEqual(Object.keys(boundaries[1]!), ["kind", "at", "boundary"]);
  deepStrictEqual(Object.keys(boundaries[1]!.boundary), ["kind", "state"]);
  deepStrictEqual(disallowedBoundaryKeys(boundaries), []);
});

test("block timeline placements are stable anchors without Wasm local mechanics", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "jump", target: c(0x40) }
    ]
  });
  const timeline = result.timeline;
  const nonExitBoundaryPlacements = timeline.filter((site) =>
    site.kind !== "boundary" || site.boundary.kind !== "exitState"
  );

  strictEqual(
    new Set(nonExitBoundaryPlacements.map((site) => `${site.at.opIndex}:${site.at.epoch}`)).size,
    nonExitBoundaryPlacements.length
  );
  deepStrictEqual(disallowedWasmKeys(timeline), []);
});

function timelineSiteKind(
  site: BlockTimelineSite
): BlockAction["kind"] | BlockDefinition["kind"] | BlockBoundarySite["boundary"]["kind"] {
  switch (site.kind) {
    case "action":
      return site.action.kind;
    case "definition":
      return site.definition.kind;
    case "boundary":
      return site.boundary.kind;
  }
}

function requireActionSite<TKind extends BlockAction["kind"]>(
  site: BlockTimelineSite | undefined,
  kind: TKind
): ActionSiteFor<TKind> {
  strictEqual(site?.kind, "action");
  const actionSite = site as ActionSiteFor<TKind>;

  strictEqual(actionSite.action.kind, kind);
  return actionSite;
}

function requireDefinitionSite<TKind extends BlockDefinition["kind"]>(
  site: BlockTimelineSite | undefined,
  kind: TKind
): DefinitionSiteFor<TKind> {
  strictEqual(site?.kind, "definition");
  const definitionSite = site as DefinitionSiteFor<TKind>;

  strictEqual(definitionSite.definition.kind, kind);
  return definitionSite;
}

function requireBoundarySite<TKind extends BlockBoundarySite["boundary"]["kind"]>(
  site: BlockTimelineSite | undefined,
  kind: TKind
): BoundarySiteFor<TKind> {
  strictEqual(site?.kind, "boundary");
  const boundarySite = site as BoundarySiteFor<TKind>;

  strictEqual(boundarySite.boundary.kind, kind);
  return boundarySite;
}

function walkFragment(
  input: Parameters<typeof walkExpressionBlock>[0]
): ReturnType<typeof walkExpressionBlock> {
  return walkExpressionBlock(input);
}

function boundarySitesOnly(timeline: readonly BlockTimelineSite[]): readonly BlockBoundarySite[] {
  return timeline.flatMap((site) => site.kind === "boundary" ? [site] : []);
}

type ActionSiteFor<TKind extends BlockAction["kind"]> =
  Extract<BlockTimelineSite, { kind: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: TKind }> }>;

type DefinitionSiteFor<TKind extends BlockDefinition["kind"]> =
  Extract<BlockTimelineSite, { kind: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: TKind }> }>;

type BoundarySiteFor<TKind extends BlockBoundarySite["boundary"]["kind"]> =
  BlockBoundarySite & Readonly<{
    boundary: Extract<BlockBoundarySite["boundary"], { kind: TKind }>;
  }>;

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
