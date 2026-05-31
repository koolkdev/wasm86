import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockExit,
  BlockExitId
} from "#ir/block/exits.js";
import {
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import {
  type BlockActionSite,
  definitionSites,
  type BlockTimelineSite,
  type Placement
} from "#ir/block/timeline.js";
import {
  buildTimelineConstraints,
  buildValuePolicyContext,
  canMaterializeCellAt,
  canUseValueAt,
  programPoint,
  producedValuesForDefinitions
} from "#ir/block/values/index.js";
import {
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import { opSite } from "#ir/block/walk/site.js";
import { BlockState } from "#ir/block/walk/state.js";
import {
  exprConst,
  exprInput,
  exprProject
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("value policy blocks source inputs and definition access across matching barriers", () => {
  const dynamic = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const dynamicConstraints = buildTimelineConstraints({ timeline: dynamic.timeline });
  const dynamicContext = buildValuePolicyContext({
    constraints: dynamicConstraints,
    timeline: dynamic.timeline,
    materializationValues: []
  });
  const dynamicStore = onlyActionSite(dynamic.timeline, "dynamicRegisterStore");
  const sourceDecision = canUseValueAt(
    dynamicContext,
    {
      kind: "sourceInput",
      source: sourceCellForRegisterAlias(registerAlias("eax"))
    },
    programPoint(dynamicConstraints.paths.root, dynamicStore.at, "after")
  );

  strictEqual(sourceDecision.kind, "blocked");
  if (sourceDecision.kind === "blocked") {
    strictEqual(sourceDecision.by.kind, "readBarrier");
    strictEqual(sourceDecision.by.barrier.domain.kind, "source");
  }

  const memory = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const memoryConstraints = buildTimelineConstraints({ timeline: memory.timeline });
  const memoryContext = buildValuePolicyContext({
    constraints: memoryConstraints,
    timeline: memory.timeline,
    materializationValues: []
  });
  const load = onlyDefinitionSite(memory.timeline, "memoryLoad");
  const store = onlyActionSite(memory.timeline, "memoryStore");
  const definitionDecision = canUseValueAt(
    memoryContext,
    {
      kind: "definitionInput",
      definition: load.definition.id
    },
    programPoint(memoryConstraints.paths.root, store.at, "after")
  );

  strictEqual(definitionDecision.kind, "blocked");
  if (definitionDecision.kind === "blocked") {
    strictEqual(definitionDecision.by.kind, "readBarrier");
    strictEqual(definitionDecision.by.barrier.domain.kind, "definitionReplay");
  }
});

test("same-site action inputs are available before the action's barrier is crossed", () => {
  const dynamic = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const dynamicConstraints = buildTimelineConstraints({ timeline: dynamic.timeline });
  const dynamicContext = buildValuePolicyContext({
    constraints: dynamicConstraints,
    timeline: dynamic.timeline,
    materializationValues: []
  });
  const dynamicStore = onlyActionSite(dynamic.timeline, "dynamicRegisterStore");

  deepStrictEqual(canUseValueAt(
    dynamicContext,
    {
      kind: "sourceInput",
      source: sourceCellForRegisterAlias(registerAlias("eax"))
    },
    programPoint(dynamicConstraints.paths.root, dynamicStore.at, "at")
  ), { kind: "available" });

  const memory = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const memoryConstraints = buildTimelineConstraints({ timeline: memory.timeline });
  const memoryContext = buildValuePolicyContext({
    constraints: memoryConstraints,
    timeline: memory.timeline,
    materializationValues: []
  });
  const load = onlyDefinitionSite(memory.timeline, "memoryLoad");
  const store = onlyActionSite(memory.timeline, "memoryStore");

  deepStrictEqual(canUseValueAt(
    memoryContext,
    {
      kind: "definitionInput",
      definition: load.definition.id
    },
    programPoint(memoryConstraints.paths.root, store.at, "at")
  ), { kind: "available" });
});

test("value policy rejects unknown definition ids", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "next" }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: []
  });

  throws(() => canUseValueAt(
    context,
    {
      kind: "definitionInput",
      definition: 999 as BlockDefinitionId
    },
    programPoint(constraints.paths.root, { opIndex: 0, epoch: 0 }, "after")
  ), /definition 999 is not present/);
});

test("value policy context rejects produced values from another block", () => {
  const first = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 }
    ]
  });
  const second = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: first.timeline });
  const staleProducedValues = producedValuesForDefinitions({
    definitions: definitionSites(second.timeline)
  });

  throws(() => buildValuePolicyContext({
    constraints,
    timeline: first.timeline,
    producedValues: staleProducedValues,
    materializationValues: []
  }), /produced value 0 does not match timeline constraint definition site/);
});

test("materialization blocks matching memory-load candidates after memory store barriers", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(0x55), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const load = onlyDefinitionSite(result.timeline, "memoryLoad");
  const observation = constraints.cellObservations.find((candidate) =>
    candidate.point.path.kind === "exit" &&
      cellEquals(candidate.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (observation === undefined) {
    throw new Error("missing fallthrough observation");
  }

  const value = exprInput({ kind: "def", id: load.definition.id });
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  deepStrictEqual(observation.value, value);

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, observation.point.at, "before")
  });

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "valueUnavailable");
    strictEqual(decision.by.decision.kind, "blocked");
    if (decision.by.decision.kind === "blocked") {
      strictEqual(decision.by.decision.by.kind, "readBarrier");
      strictEqual(decision.by.decision.by.barrier.domain.kind, "definitionReplay");
    }
  }
});

test("materialization blocks matching source-register candidates after dynamic register barriers", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80),
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const observation = constraints.cellObservations.find((candidate) =>
    candidate.point.path.kind === "exit" &&
      cellEquals(candidate.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (observation === undefined) {
    throw new Error("missing fallthrough observation");
  }

  const value = exprInput({ kind: "reg", reg: "eax" });
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  deepStrictEqual(observation.value, value);

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, observation.point.at, "before")
  });

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "valueUnavailable");
    strictEqual(decision.by.decision.kind, "blocked");
    if (decision.by.decision.kind === "blocked") {
      strictEqual(decision.by.decision.by.kind, "readBarrier");
      strictEqual(decision.by.decision.by.barrier.domain.kind, "source");
    }
  }
});

test("materialization before a branch covers both branch observations", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const taken = constraints.cellObservations.find((target) =>
    target.point.path.kind === "branch" &&
      target.point.path.at.opIndex === 1 &&
      target.point.path.at.epoch === 0 &&
      target.point.path.arm === "taken" &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const notTaken = constraints.cellObservations.find((target) =>
    target.point.path.kind === "branch" &&
      target.point.path.at.opIndex === 1 &&
      target.point.path.at.epoch === 0 &&
      target.point.path.arm === "notTaken" &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (taken === undefined || notTaken === undefined) {
    throw new Error("missing branch exit targets");
  }

  const value = exprProject(32, exprConst(0x11));
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, taken.point.at, "before")
  });

  strictEqual(decision.kind, "available");
  if (decision.kind === "available") {
    deepStrictEqual(decision.covers, [taken, notTaken]);
  }
});

test("conflicting branch observations block hoisting before the branch", () => {
  const timeline = [
    branchSite({ opIndex: 1, epoch: 0 }, exprConst(0x11), exprConst(0x22))
  ];
  const constraints = buildTimelineConstraints({ timeline });
  const taken = constraints.cellObservations.find((observation) =>
    observation.point.path.kind === "branch" &&
      observation.point.path.arm === "taken" &&
      cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const notTaken = constraints.cellObservations.find((observation) =>
    observation.point.path.kind === "branch" &&
      observation.point.path.arm === "notTaken" &&
      cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (taken === undefined || notTaken === undefined) {
    throw new Error("missing branch observations");
  }

  const value = exprConst(0x11);
  const context = buildValuePolicyContext({
    constraints,
    timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, taken.point.at, "before")
  });

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "conflictingObservation");
    strictEqual(decision.by.observation, notTaken);
  }
});

test("materialization inside one control region does not cover a sibling region", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const taken = constraints.cellObservations.find((observation) =>
    observation.point.path.kind === "branch" &&
      observation.point.path.arm === "taken" &&
      cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const notTaken = constraints.cellObservations.find((observation) =>
    observation.point.path.kind === "branch" &&
      observation.point.path.arm === "notTaken" &&
      cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (taken === undefined || notTaken === undefined) {
    throw new Error("missing branch observations");
  }

  const value = exprConst(0x11);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(taken.point.path, taken.point.at, "before")
  });

  strictEqual(decision.kind, "available");
  if (decision.kind === "available") {
    deepStrictEqual(decision.covers, [taken]);
    strictEqual(decision.covers.includes(notTaken), false);
  }
});

test("memory guard fault observation is covered by materialization before the guard", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const guard = onlyActionSite(result.timeline, "memoryGuard");
  const faultTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 0 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const fallthroughTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 1 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (faultTarget === undefined || fallthroughTarget === undefined) {
    throw new Error("missing exit targets");
  }

  deepStrictEqual(faultTarget.value, exprInput({ kind: "reg", reg: "eax" }));
  deepStrictEqual(fallthroughTarget.value, exprInput({ kind: "reg", reg: "eax" }));

  const value = exprInput({ kind: "reg", reg: "eax" });
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, guard.at, "before")
  });

  strictEqual(decision.kind, "available");
  if (decision.kind === "available") {
    deepStrictEqual(decision.covers, [faultTarget, fallthroughTarget]);
  }
});

test("conflicting memory guard observations block hoisting before the guard", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x22), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const guard = onlyActionSite(result.timeline, "memoryGuard");
  const faultTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 0 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const fallthroughTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 1 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (faultTarget === undefined || fallthroughTarget === undefined) {
    throw new Error("missing exit targets");
  }

  deepStrictEqual(faultTarget.value, exprInput({ kind: "reg", reg: "eax" }));
  deepStrictEqual(fallthroughTarget.value, exprConst(0x22));

  const value = exprConst(0x22);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, guard.at, "before")
  });

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "conflictingObservation");
    strictEqual(decision.by.observation, faultTarget);
  }
});

test("same value across multiple observations allows hoisting", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const guard = onlyActionSite(result.timeline, "memoryGuard");
  const faultTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 0 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const fallthroughTarget = constraints.cellObservations.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 1 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (faultTarget === undefined || fallthroughTarget === undefined) {
    throw new Error("missing exit targets");
  }

  const sharedValue = exprProject(32, exprConst(0x11));
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [sharedValue]
  });

  deepStrictEqual(faultTarget.value, exprConst(0x11));
  deepStrictEqual(fallthroughTarget.value, exprConst(0x11));
  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value: sharedValue,
    at: programPoint(constraints.paths.root, guard.at, "before")
  });

  strictEqual(decision.kind, "available");
  if (decision.kind === "available") {
    deepStrictEqual(decision.covers, [faultTarget, fallthroughTarget]);
  }
});

test("materialization rejects candidates that do not match covered observations", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const observation = constraints.cellObservations.find((candidate) =>
    candidate.point.path.kind === "exit" &&
      candidate.point.path.exit === 0 &&
      cellEquals(candidate.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (observation === undefined) {
    throw new Error("missing exit observation");
  }

  const value = exprConst(0x22);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [value]
  });

  const decision = canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value,
    at: programPoint(constraints.paths.root, observation.point.at, "before")
  });

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "conflictingObservation");
    strictEqual(decision.by.observation, observation);
  }
});

test("value policy context requires declared materialization values", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x22), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const guard = onlyActionSite(result.timeline, "memoryGuard");
  const candidate = exprConst(0x33);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: [candidate]
  });

  strictEqual(canMaterializeCellAt(context, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value: candidate,
    at: programPoint(constraints.paths.root, guard.at, "before")
  }).kind, "blocked");

  const incompleteContext = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    materializationValues: []
  });

  throws(() => canMaterializeCellAt(incompleteContext, {
    cell: sourceCellForRegisterAlias(registerAlias("eax")),
    value: candidate,
    at: programPoint(constraints.paths.root, guard.at, "before")
  }), /materialization value expression was not declared in materializationValues/);
});

function branchSite(
  at: Placement,
  takenEax: ExprRef,
  notTakenEax: ExprRef
): BlockActionSite & Readonly<{ action: Extract<BlockAction, { kind: "branch" }> }> {
  const site = opSite(at.opIndex);

  return Object.freeze({
    kind: "action",
    at,
    action: Object.freeze({
      kind: "branch",
      at: site,
      condition: exprConst(1),
      takenTarget: exprConst(0x40),
      continuation: Object.freeze({ kind: "continuation" }),
      taken: branchExit(0, site, "taken", blockStateWithEax(takenEax)),
      notTaken: branchExit(1, site, "notTaken", blockStateWithEax(notTakenEax))
    } satisfies Extract<BlockAction, { kind: "branch" }>)
  });
}

function branchExit(
  id: number,
  at: ReturnType<typeof opSite>,
  direction: "taken" | "notTaken",
  snapshot: BlockState
): BlockExit {
  return Object.freeze({
    id: id as BlockExitId,
    at,
    kind: direction === "taken" ? "branchTaken" : "branchNotTaken",
    snapshot,
    payload: direction === "taken"
      ? Object.freeze({
        kind: "branch",
        direction,
        target: exprConst(0x40)
      })
      : Object.freeze({
        kind: "branch",
        direction
      })
  } satisfies BlockExit);
}

function blockStateWithEax(value: ExprRef): BlockState {
  const state = BlockState.initial();

  return state.withRegisters(state.registers.write("eax", value));
}

function cellEquals(left: SourceCell, right: SourceCell): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "flag":
      return right.kind === "flag" && left.flag === right.flag;
    case "reg":
      return right.kind === "reg" &&
        left.reg.name === right.reg.name &&
        left.reg.base === right.reg.base &&
        left.reg.bitOffset === right.reg.bitOffset &&
        left.reg.width === right.reg.width;
  }
}

function onlyActionSite<TKind extends ReturnType<typeof timelineKind>>(
  timeline: readonly BlockTimelineSite[],
  kind: TKind
) {
  const sites = timeline.filter((site) =>
    site.kind === "action" && site.action.kind === kind
  );

  strictEqual(sites.length, 1);
  return sites[0] as Extract<typeof sites[number], { kind: "action" }>;
}

function onlyDefinitionSite<TKind extends ReturnType<typeof timelineKind>>(
  timeline: readonly BlockTimelineSite[],
  kind: TKind
) {
  const sites = timeline.filter((site) =>
    site.kind === "definition" && site.definition.kind === kind
  );

  strictEqual(sites.length, 1);
  return sites[0] as Extract<typeof sites[number], { kind: "definition" }>;
}

function timelineKind(
  site: BlockTimelineSite
): string {
  switch (site.kind) {
    case "action":
      return site.action.kind;
    case "definition":
      return site.definition.kind;
  }
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
