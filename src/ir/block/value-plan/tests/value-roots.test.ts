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
  type BlockRoot,
  rootsForBlockSites
} from "#ir/block/roots.js";
import type {
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
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import {
  producedValuesForDefinitions,
  type ProducedValue
} from "#ir/block/value-plan/produced-values.js";
import {
  isActionInputValueRoot,
  isBoundaryCellValueRoot,
  isDefinitionInputValueRoot,
  valueRootExpr,
  valueRootPlacement,
  valueRootPurpose,
  valueRootsForRoots,
  type ValueRoot,
  type ValueRootInput
} from "#ir/block/value-plan/value-roots.js";

test("every non-passthrough root becomes one value root", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const roots = rootsForBlockSites({ timeline: result.timeline });
  const valueRoots = valueRootsForRoots(valueRootInput(result.timeline, roots));

  strictEqual(valueRoots.length, roots.filter((root) => root.purpose.kind !== "boundaryCell").length);
  deepStrictEqual(valueRoots.map(rootSummary), [
    {
      id: 0,
      kind: "actionInput",
      at: { opIndex: 0, epoch: 0 },
      action: "memoryGuard",
      input: "address"
    }
  ]);
});

test("duplicate roots remain duplicate value roots", () => {
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

  const valueRoots = valueRootsForRoots(valueRootInput(result.timeline, [root, root]));

  strictEqual(valueRoots.length, 2);
  strictEqual(valueRoots[0]?.id, 0);
  strictEqual(valueRoots[1]?.id, 1);
  strictEqual(valueRoots[0]?.root, root);
  strictEqual(valueRoots[1]?.root, root);
});

test("root purpose maps through the value-root helpers", () => {
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
  const valueRoots = valueRootsForRoots(valueRootInput(timeline));

  requireActionRoot(valueRoots, "memoryGuard", "address");
  requireDefinitionRoot(valueRoots, "memoryLoad", "address");
  requireActionRoot(valueRoots, "memoryStore", "address");
  requireActionRoot(valueRoots, "memoryStore", "value");
  requireDefinitionRoot(valueRoots, "dynamicRegisterLoad", "index");
  requireActionRoot(valueRoots, "dynamicRegisterStore", "index");
  requireActionRoot(valueRoots, "dynamicRegisterStore", "value");
  requireActionRoot(valueRoots, "branch", "condition");
  requireActionRoot(valueRoots, "branch", "target", "taken");
  requireActionRoot(valueRoots, "branch", "target", "notTaken");
  requireActionRoot(valueRoots, "hostTrap", "vector");
  requireActionRoot(valueRoots, "fallthrough", "target");
  requireBoundaryRoot(valueRoots, "stateSync", "reg", "eax");

  strictEqual(isActionInputValueRoot(valueRoots[0]!), true);
  strictEqual(isDefinitionInputValueRoot(requireDefinitionRoot(valueRoots, "memoryLoad", "address")), true);
  strictEqual(isBoundaryCellValueRoot(requireBoundaryRoot(valueRoots, "stateSync", "reg", "eax")), true);
});

test("passthrough state-sync register and flag cells are skipped", () => {
  const timeline = [
    stateSyncSite({ opIndex: 0, epoch: 0 }, BlockState.initial())
  ];

  deepStrictEqual(valueRootsForRoots(valueRootInput(timeline)), []);
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

  deepStrictEqual(valueRootsForRoots(valueRootInput(result.timeline, boundaryRoots)), []);
});

test("changed boundary cells become value roots", () => {
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
  const valueRoots = valueRootsForRoots(valueRootInput(timeline));

  deepStrictEqual(valueRoots.map(rootSummary), [
    {
      id: 0,
      kind: "boundaryCell",
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "reg", reg: "eax" }
    },
    {
      id: 1,
      kind: "boundaryCell",
      at: { opIndex: 4, epoch: 0 },
      boundary: "stateSync",
      cell: { kind: "flag", flag: "CF" }
    }
  ]);
});

test("value roots do not duplicate graph keys, deps, purpose, or placement", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const root = rootsForBlockSites({ timeline: result.timeline })[0]!;
  const valueRoot = valueRootsForRoots({ roots: [root] })[0]!;

  deepStrictEqual(Object.keys(valueRoot), ["id", "root"]);
  strictEqual(Object.hasOwn(valueRoot, "key"), false);
  strictEqual(Object.hasOwn(valueRoot, "expr"), false);
  strictEqual(Object.hasOwn(valueRoot, "deps"), false);
  strictEqual(Object.hasOwn(valueRoot, "at"), false);
  strictEqual(Object.hasOwn(valueRoot, "purpose"), false);
  strictEqual(valueRootExpr(valueRoot), root.expr);
  strictEqual(valueRootPlacement(valueRoot), root.at);
  strictEqual(valueRootPurpose(valueRoot), root.purpose);
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

function valueRootInput(
  timeline: BlockTimeline,
  roots = rootsForBlockSites({ timeline })
): ValueRootInput {
  return { roots };
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

function requireActionRoot(
  roots: readonly ValueRoot[],
  action: BlockAction["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "actionInput" }>["input"],
  direction?: "taken" | "notTaken"
): ValueRoot {
  const root = roots.find((candidate) =>
    candidate.root.purpose.kind === "actionInput" &&
      candidate.root.site.kind === "action" &&
      candidate.root.site.action.kind === action &&
      candidate.root.purpose.input === input &&
      candidate.root.purpose.direction === direction
  );

  if (root === undefined) {
    throw new Error(`missing ${action} ${input} action value root`);
  }

  return root;
}

function requireDefinitionRoot(
  roots: readonly ValueRoot[],
  definition: BlockDefinition["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "definitionInput" }>["input"]
): ValueRoot {
  const root = roots.find((candidate) =>
    candidate.root.purpose.kind === "definitionInput" &&
      candidate.root.site.kind === "definition" &&
      candidate.root.site.definition.kind === definition &&
      candidate.root.purpose.input === input
  );

  if (root === undefined) {
    throw new Error(`missing ${definition} ${input} definition value root`);
  }

  return root;
}

function requireBoundaryRoot(
  roots: readonly ValueRoot[],
  boundary: "stateSync" | "exitState",
  kind: "reg" | "flag",
  name: string
): ValueRoot {
  const root = roots.find((candidate) =>
    candidate.root.purpose.kind === "boundaryCell" &&
      candidate.root.site.kind === "boundary" &&
      candidate.root.site.boundary.kind === boundary &&
      candidate.root.purpose.cell.kind === kind &&
      (candidate.root.purpose.cell.kind === "reg"
        ? candidate.root.purpose.cell.reg
        : candidate.root.purpose.cell.flag) === name
  );

  if (root === undefined) {
    throw new Error(`missing ${boundary} ${kind} ${name} boundary value root`);
  }

  return root;
}

function rootSummary(root: ValueRoot): object {
  const blockRoot = root.root;
  const base = {
    id: root.id,
    kind: blockRoot.purpose.kind,
    at: blockRoot.at
  };

  switch (blockRoot.purpose.kind) {
    case "actionInput":
      if (blockRoot.site.kind !== "action") {
        throw new Error("action-input root must reference an action site");
      }

      return {
        ...base,
        action: blockRoot.site.action.kind,
        input: blockRoot.purpose.input,
        ...(blockRoot.purpose.direction === undefined ? {} : { direction: blockRoot.purpose.direction })
      };
    case "definitionInput":
      if (blockRoot.site.kind !== "definition") {
        throw new Error("definition-input root must reference a definition site");
      }

      return {
        ...base,
        definition: blockRoot.site.definition.kind,
        input: blockRoot.purpose.input
      };
    case "boundaryCell":
      if (blockRoot.site.kind !== "boundary") {
        throw new Error("boundary-cell root must reference a boundary site");
      }

      return {
        ...base,
        boundary: blockRoot.site.boundary.kind,
        cell: blockRoot.purpose.cell
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
