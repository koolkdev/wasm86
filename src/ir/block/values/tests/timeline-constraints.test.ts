import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  buildConstraintIndex,
  pathCoversInConstraints
} from "#ir/block/values/policy/constraint-index.js";
import type {
  BlockExit,
  BlockExitId
} from "#ir/block/exits.js";
import {
  buildTimelineConstraints,
  pathEquals,
  programPoint,
  type Path
} from "#ir/block/values/index.js";
import {
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import {
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  opSite
} from "#ir/block/walk/site.js";
import {
  BlockState
} from "#ir/block/walk/state.js";
import type {
  BlockActionSite,
  Placement
} from "#ir/block/timeline.js";
import {
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import type {
  IrValueType,
  ValueRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("dynamic-register stores contribute barriers and pending-state cell observations at the action", () => {
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
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const store = onlyActionSite(result.timeline, "dynamicRegisterStore");

  deepStrictEqual(result.timeline.map(timelineKind), ["dynamicRegisterStore"]);
  deepStrictEqual(constraints.readBarriers.map((barrier) => ({
    point: barrier.point,
    domain: barrier.domain,
    site: barrier.site === store
  })), [
    {
      point: { path: constraints.paths.root, at: store.at, phase: "at" },
      domain: { kind: "source", source: { kind: "registerScope" } },
      site: true
    },
    {
      point: { path: constraints.paths.root, at: store.at, phase: "at" },
      domain: { kind: "definitionReplay", domain: { kind: "registers" } },
      site: true
    }
  ]);

  const point = programPoint(constraints.paths.root, store.at, "before");
  deepStrictEqual(
    observationSummary(observationFor(constraints.cellObservations, point, sourceCellForRegisterAlias(registerAlias("eax")))),
    {
      point,
      cell: sourceCellForRegisterAlias(registerAlias("eax")),
      value: exprInput({ kind: "reg", reg: "eax" }),
      site: "dynamicRegisterStore"
    }
  );
  deepStrictEqual(
    observationSummary(observationFor(constraints.cellObservations, point, sourceCellForRegisterAlias(registerAlias("esp")))),
    {
      point,
      cell: sourceCellForRegisterAlias(registerAlias("esp")),
      value: exprConst(0x44),
      site: "dynamicRegisterStore"
    }
  );
  deepStrictEqual(
    observationSummary(observationFor(constraints.cellObservations, point, sourceCellForFlag("ZF"))),
    {
      point,
      cell: sourceCellForFlag("ZF"),
      value: exprConst(1),
      site: "dynamicRegisterStore"
    }
  );
});

test("memory stores contribute memory replay barriers without source read barriers", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x1000) }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const store = onlyActionSite(result.timeline, "memoryStore");

  deepStrictEqual(constraints.readBarriers.map((barrier) => ({
    at: barrier.point.at,
    domain: barrier.domain,
    site: barrier.site === store
  })), [
    {
      at: store.at,
      domain: { kind: "definitionReplay", domain: { kind: "memory" } },
      site: true
    }
  ]);
  strictEqual(constraints.readBarriers.some((barrier) => barrier.domain.kind === "source"), false);
});

test("exit-bearing actions contribute path-local cell observations", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const index = buildConstraintIndex(constraints);
  const observations = constraints.cellObservations.filter((observation) =>
    cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  deepStrictEqual(result.timeline.map(timelineKind), ["branch"]);
  deepStrictEqual(constraints.paths.edges.map((edge) => ({
    parent: pathSummary(edge.parent),
    child: pathSummary(edge.child)
  })), [
    {
      parent: { kind: "root" },
      child: { kind: "branch", at: { opIndex: 1, epoch: 0 }, arm: "taken" }
    },
    {
      parent: { kind: "root" },
      child: { kind: "branch", at: { opIndex: 1, epoch: 0 }, arm: "notTaken" }
    }
  ]);
  deepStrictEqual(observations.map((observation) => ({
    path: pathSummary(observation.point.path),
    value: observation.value,
    site: timelineKind(observation.site)
  })), [
    {
      path: { kind: "branch", at: { opIndex: 1, epoch: 0 }, arm: "taken" },
      value: exprConst(0x11),
      site: "branch"
    },
    {
      path: { kind: "branch", at: { opIndex: 1, epoch: 0 }, arm: "notTaken" },
      value: exprConst(0x11),
      site: "branch"
    }
  ]);
  strictEqual(pathCoversInConstraints(index, constraints.paths.root, observations[0]!.point.path), true);
  strictEqual(pathCoversInConstraints(index, observations[0]!.point.path, observations[1]!.point.path), false);
});

test("branch paths include timeline epoch to avoid same-op collisions", () => {
  const constraints = buildTimelineConstraints({
    timeline: [
      branchSite({ opIndex: 7, epoch: 0 }, 0),
      branchSite({ opIndex: 7, epoch: 1 }, 2)
    ]
  });
  const children = constraints.paths.edges.map((edge) => edge.child);

  deepStrictEqual(children.map(pathSummary), [
    { kind: "branch", at: { opIndex: 7, epoch: 0 }, arm: "taken" },
    { kind: "branch", at: { opIndex: 7, epoch: 0 }, arm: "notTaken" },
    { kind: "branch", at: { opIndex: 7, epoch: 1 }, arm: "taken" },
    { kind: "branch", at: { opIndex: 7, epoch: 1 }, arm: "notTaken" }
  ]);
  for (let left = 0; left < children.length; left += 1) {
    for (let right = left + 1; right < children.length; right += 1) {
      strictEqual(pathEquals(children[left]!, children[right]!), false);
    }
  }
});

test("non-branch exits contribute cell observations on dedicated exit paths", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11), accessWidth: 32 },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "next" }
    ],
    continuation: exprConst(0x80)
  });
  const constraints = buildTimelineConstraints({ timeline: result.timeline });
  const index = buildConstraintIndex(constraints);
  const observations = constraints.cellObservations.filter((observation) =>
    cellEquals(observation.cell, sourceCellForRegisterAlias(registerAlias("eax")))
  );

  deepStrictEqual(result.timeline.map(timelineKind), ["memoryGuard", "fallthrough"]);
  deepStrictEqual(observations.map((observation) => ({
    path: pathSummary(observation.point.path),
    value: observation.value,
    site: timelineKind(observation.site)
  })), [
    {
      path: { kind: "exit", exit: 0, exitKind: "memoryFault" },
      value: exprConst(0x11),
      site: "memoryGuard"
    },
    {
      path: { kind: "exit", exit: 1, exitKind: "fallthrough" },
      value: exprConst(0x11),
      site: "fallthrough"
    }
  ]);
  strictEqual(pathCoversInConstraints(index, constraints.paths.root, observations[0]!.point.path), true);
  strictEqual(pathCoversInConstraints(index, observations[0]!.point.path, observations[1]!.point.path), false);
  strictEqual(observations.some((observation) => observation.point.path === constraints.paths.root), false);
});

function observationFor(
  observations: ReturnType<typeof buildTimelineConstraints>["cellObservations"],
  point: ReturnType<typeof programPoint>,
  cell: SourceCell
): ReturnType<typeof buildTimelineConstraints>["cellObservations"][number] {
  const observation = observations.find((candidate) =>
    sameProgramPoint(candidate.point, point) &&
      cellEquals(candidate.cell, cell)
  );

  if (observation === undefined) {
    throw new Error("missing cell observation");
  }

  return observation;
}

function observationSummary(
  observation: ReturnType<typeof buildTimelineConstraints>["cellObservations"][number]
): object {
  return {
    point: observation.point,
    cell: observation.cell,
    value: observation.value,
    site: timelineKind(observation.site)
  };
}

function pathSummary(path: Path): object {
  switch (path.kind) {
    case "root":
      return { kind: "root" };
    case "branch":
      return {
        kind: "branch",
        at: path.at,
        arm: path.arm
      };
    case "exit":
      return {
        kind: "exit",
        exit: path.exit,
        exitKind: path.exitKind
      };
  }
}

function sameProgramPoint(
  left: ReturnType<typeof programPoint>,
  right: ReturnType<typeof programPoint>
): boolean {
  return pathEquals(left.path, right.path) &&
    left.at.opIndex === right.at.opIndex &&
    left.at.epoch === right.at.epoch &&
    left.phase === right.phase;
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
  timeline: ReturnType<typeof walkExpressionBlock>["timeline"],
  kind: TKind
) {
  const sites = timeline.filter((site) =>
    site.kind === "action" && site.action.kind === kind
  );

  strictEqual(sites.length, 1);
  return sites[0] as Extract<typeof sites[number], { kind: "action" }>;
}

function timelineKind(
  site: ReturnType<typeof walkExpressionBlock>["timeline"][number]
): string {
  switch (site.kind) {
    case "action":
      return site.action.kind;
    case "definition":
      return site.definition.kind;
  }
}

function branchSite(
  at: Placement,
  firstExitId: number
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
      taken: branchExit(firstExitId, site, "taken"),
      notTaken: branchExit(firstExitId + 1, site, "notTaken")
    } satisfies Extract<BlockAction, { kind: "branch" }>)
  });
}

function branchExit(
  id: number,
  at: ReturnType<typeof opSite>,
  direction: "taken" | "notTaken"
): BlockExit {
  return Object.freeze({
    id: id as BlockExitId,
    at,
    kind: direction === "taken" ? "branchTaken" : "branchNotTaken",
    snapshot: BlockState.initial(),
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

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
