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
import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import {
  definitionSites,
  type BlockTimelineSite
} from "#ir/block/timeline.js";
import {
  buildTimelineConstraints,
  buildValuePolicyContext,
  canUseValueAt,
  canWriteCellValueTargetAt,
  pathPoint,
  producedValuesForDefinitions
} from "#ir/block/values/index.js";
import {
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprConst,
  exprInput,
  exprProject
} from "#ir/expr/builders.js";
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
    storeCandidates: []
  });
  const dynamicStore = onlyActionSite(dynamic.timeline, "dynamicRegisterStore");
  const sourceDecision = canUseValueAt(
    dynamicContext,
    {
      kind: "sourceInput",
      source: sourceCellForRegisterAlias(registerAlias("eax"))
    },
    pathPoint(dynamicConstraints.paths.root, dynamicStore.at, "after")
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
    storeCandidates: []
  });
  const load = onlyDefinitionSite(memory.timeline, "memoryLoad");
  const store = onlyActionSite(memory.timeline, "memoryStore");
  const definitionDecision = canUseValueAt(
    memoryContext,
    {
      kind: "definitionInput",
      definition: load.definition.id
    },
    pathPoint(memoryConstraints.paths.root, store.at, "after")
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
    storeCandidates: []
  });
  const dynamicStore = onlyActionSite(dynamic.timeline, "dynamicRegisterStore");

  deepStrictEqual(canUseValueAt(
    dynamicContext,
    {
      kind: "sourceInput",
      source: sourceCellForRegisterAlias(registerAlias("eax"))
    },
    pathPoint(dynamicConstraints.paths.root, dynamicStore.at, "at")
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
    storeCandidates: []
  });
  const load = onlyDefinitionSite(memory.timeline, "memoryLoad");
  const store = onlyActionSite(memory.timeline, "memoryStore");

  deepStrictEqual(canUseValueAt(
    memoryContext,
    {
      kind: "definitionInput",
      definition: load.definition.id
    },
    pathPoint(memoryConstraints.paths.root, store.at, "at")
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
    storeCandidates: []
  });

  throws(() => canUseValueAt(
    context,
    {
      kind: "definitionInput",
      definition: 999 as BlockDefinitionId
    },
    pathPoint(constraints.paths.root, { opIndex: 0, epoch: 0 }, "after")
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
    storeCandidates: []
  }), /produced value 0 does not match timeline constraint definition site/);
});

test("value policy rejects cell stores that do not cover the cell value target path", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const taken = constraints.cellValueTargets.find((target) =>
    target.point.path.kind === "branch" &&
      target.point.path.at.opIndex === 1 &&
      target.point.path.at.epoch === 0 &&
      target.point.path.arm === "taken" &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const notTaken = constraints.cellValueTargets.find((target) =>
    target.point.path.kind === "branch" &&
      target.point.path.at.opIndex === 1 &&
      target.point.path.at.epoch === 0 &&
      target.point.path.arm === "notTaken" &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (taken === undefined || notTaken === undefined) {
    throw new Error("missing branch exit targets");
  }

  const value = exprConst(0x11);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    storeCandidates: [value]
  });
  const decision = canWriteCellValueTargetAt(
    context,
    notTaken,
    value,
    pathPoint(taken.point.path, taken.point.at, "before")
  );

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "pathNotCovered");
  }
});

test("memory-guard passthrough cell value targets block stores before the guard", () => {
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
  const faultTarget = constraints.cellValueTargets.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 0 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const fallthroughTarget = constraints.cellValueTargets.find((target) =>
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
    storeCandidates: [value]
  });
  const decision = canWriteCellValueTargetAt(
    context,
    fallthroughTarget,
    value,
    pathPoint(constraints.paths.root, guard.at, "before")
  );

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "cellValueTarget");
    strictEqual(decision.by.target, faultTarget);
  }
});

test("value policy allows shared stores across same-value cell value targets", () => {
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
  const faultTarget = constraints.cellValueTargets.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 0 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );
  const fallthroughTarget = constraints.cellValueTargets.find((target) =>
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
    storeCandidates: [sharedValue]
  });

  deepStrictEqual(faultTarget.value, exprConst(0x11));
  deepStrictEqual(fallthroughTarget.value, exprConst(0x11));
  deepStrictEqual(canWriteCellValueTargetAt(
    context,
    fallthroughTarget,
    sharedValue,
    pathPoint(constraints.paths.root, guard.at, "before")
  ), { kind: "available" });
});

test("value policy rejects stores that do not match the cell value target", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const target = constraints.cellValueTargets.find((candidate) =>
    candidate.point.path.kind === "exit" &&
      candidate.point.path.exit === 0 &&
      cellEquals(candidate.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (target === undefined) {
    throw new Error("missing exit target");
  }

  const value = exprConst(0x22);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    storeCandidates: [value]
  });
  const decision = canWriteCellValueTargetAt(
    context,
    target,
    value,
    pathPoint(constraints.paths.root, target.point.at, "before")
  );

  strictEqual(decision.kind, "blocked");
  if (decision.kind === "blocked") {
    strictEqual(decision.by.kind, "cellValueTarget");
    strictEqual(decision.by.target, target);
  }
});

test("value policy context requires declared store candidates", () => {
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
  const fallthroughTarget = constraints.cellValueTargets.find((target) =>
    target.point.path.kind === "exit" &&
      target.point.path.exit === 1 &&
      cellEquals(target.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  if (fallthroughTarget === undefined) {
    throw new Error("missing fallthrough exit target");
  }

  const candidate = exprConst(0x33);
  const context = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    storeCandidates: [candidate]
  });

  strictEqual(canWriteCellValueTargetAt(
    context,
    fallthroughTarget,
    candidate,
    pathPoint(constraints.paths.root, guard.at, "before")
  ).kind, "blocked");

  const incompleteContext = buildValuePolicyContext({
    constraints,
    timeline: result.timeline,
    storeCandidates: []
  });

  throws(() => canWriteCellValueTargetAt(
    incompleteContext,
    fallthroughTarget,
    candidate,
    pathPoint(constraints.paths.root, guard.at, "before")
  ), /store candidate expression was not declared in storeCandidates/);
});

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
