import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  analyzeExpressionNeeds,
  analyzeStateObligations,
  buildTimelineGeometry,
  buildTimelineValueUseIndex,
  type ExprNeed,
  type ExprNeeds,
  type StateObligation,
  type TimelineValueUseIndex
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("memory store creates address and value action-input needs", () => {
  const { geometry, timelineUses, needs } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    }
  ]);
  const store = geometry.memory.writes[0]!;

  deepStrictEqual(needSummaries(needs, timelineUses), [
    { origin: { kind: "action-input", role: "address" }, expr: exprConst(0x1000) },
    { origin: { kind: "action-input", role: "value" }, expr: exprConst(0x55) }
  ]);
  const addressNeed = needs[0]!;
  const valueNeed = needs[1]!;
  const addressUse = timelineUseForNeed(addressNeed, timelineUses);
  const valueUse = timelineUseForNeed(valueNeed, timelineUses);

  strictEqual(addressUse.kind === "action-input" ? addressUse.site : undefined, store.site);
  strictEqual(valueUse.kind === "action-input" ? valueUse.site : undefined, store.site);
  strictEqual(addressNeed.point, store.point);
  strictEqual(valueNeed.point, store.point);
});

test("memory guard creates action-site and fault-exit address needs", () => {
  const { geometry, timelineUses, needs } = analyzeBlock([
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
  ]);
  const guard = geometry.memory.guards[0]!;
  const faultEdge = geometry.edges.byExit.get(guard.faultExitPoint.exit.id)!;

  deepStrictEqual(needSummaries(needs, timelineUses), [
    { origin: { kind: "action-input", role: "address" }, expr: exprConst(0x1000) },
    { origin: { kind: "exit-payload", edge: faultEdge.id, role: "address" }, expr: exprConst(0x1000) }
  ]);
  strictEqual(needs[0]!.point, guard.point);
  strictEqual(needs[1]!.point, guard.faultExitPoint.point);
});

test("memory load creates address definition-input need", () => {
  const { geometry, timelineUses, needs } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    }
  ]);
  const load = geometry.definitions.points[0]!;

  deepStrictEqual(needSummaries(needs, timelineUses), [
    { origin: { kind: "definition-input", role: "address" }, expr: exprConst(0x1000) }
  ]);
  const addressNeed = needs[0]!;
  const addressUse = timelineUseForNeed(addressNeed, timelineUses);

  strictEqual(addressUse.kind === "definition-input" ? addressUse.site : undefined, load.site);
  strictEqual(addressNeed.point, load.point);
});

test("dynamic register load and store create index and value needs", () => {
  const { geometry, timelineUses, needs } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "operand", index: 0 },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "operand", index: 1 },
      value: c(0x55),
      accessWidth: 32
    }
  ], {
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(3), 32),
        dynamicRegBinding(exprConst(4), 32)
      ]
    })
  });
  const load = geometry.definitions.points[0]!;
  const store = geometry.registers.dynamicStores[0]!;

  deepStrictEqual(needSummaries(needs, timelineUses), [
    { origin: { kind: "definition-input", role: "index" }, expr: exprConst(3) },
    { origin: { kind: "action-input", role: "index" }, expr: exprConst(4) },
    { origin: { kind: "action-input", role: "value" }, expr: exprConst(0x55) }
  ]);
  strictEqual(needs[0]!.point, load.point);
  strictEqual(needs[1]!.point, store.point);
  strictEqual(needs[2]!.point, store.point);
});

test("branch creates condition and path-specific exit payload needs", () => {
  const { geometry, timelineUses, needs } = analyzeBlock([
    {
      op: "conditionalJump",
      condition: c(1),
      taken: c(0x40),
      notTaken: c(0x44)
    }
  ]);
  const branchSite = geometry.points.bySite.values().next().value!;
  const taken = geometry.exits.points.find((point) => point.exit.kind === "branchTaken")!;
  const notTaken = geometry.exits.points.find((point) => point.exit.kind === "branchNotTaken")!;
  const takenEdge = geometry.edges.byExit.get(taken.exit.id)!;
  const notTakenEdge = geometry.edges.byExit.get(notTaken.exit.id)!;

  deepStrictEqual(needSummaries(needs, timelineUses), [
    { origin: { kind: "action-input", role: "condition" }, expr: exprConst(1) },
    { origin: { kind: "exit-payload", edge: takenEdge.id, role: "target" }, expr: exprConst(0x40) },
    { origin: { kind: "exit-payload", edge: notTakenEdge.id, role: "target" }, expr: exprConst(0x44) }
  ]);
  strictEqual(takenEdge.kind, "branch-taken");
  strictEqual(notTakenEdge.kind, "branch-not-taken");
  strictEqual(takenEdge.id === notTakenEdge.id, false);
  strictEqual(needs[0]!.point, branchSite.at);
  strictEqual(needs[1]!.point, taken.point);
  strictEqual(needs[2]!.point, notTaken.point);
});

test("jump, host trap, and fallthrough create exit-payload needs only", () => {
  const jump = analyzeBlock([{ op: "jump", target: c(0x80) }]);
  const hostTrap = analyzeBlock([{ op: "hostTrap", vector: c(0x13) }]);
  const fallthrough = analyzeBlock([{ op: "next" }], {
    continuation: exprConst(0x90)
  });
  const jumpEdge = jump.geometry.edges.byExit.get(jump.geometry.exits.points[0]!.exit.id)!;
  const hostTrapEdge = hostTrap.geometry.edges.byExit.get(hostTrap.geometry.exits.points[0]!.exit.id)!;
  const fallthroughEdge = fallthrough.geometry.edges.byExit.get(fallthrough.geometry.exits.points[0]!.exit.id)!;

  deepStrictEqual(needSummaries(jump.needs, jump.timelineUses), [
    { origin: { kind: "exit-payload", edge: jumpEdge.id, role: "target" }, expr: exprConst(0x80) }
  ]);
  deepStrictEqual(needSummaries(hostTrap.needs, hostTrap.timelineUses), [
    { origin: { kind: "exit-payload", edge: hostTrapEdge.id, role: "vector" }, expr: exprConst(0x13) }
  ]);
  deepStrictEqual(needSummaries(fallthrough.needs, fallthrough.timelineUses), [
    { origin: { kind: "exit-payload", edge: fallthroughEdge.id, role: "target" }, expr: exprConst(0x90) }
  ]);
  strictEqual(jump.needs[0]!.point, jump.geometry.exits.points[0]!.point);
  strictEqual(hostTrap.needs[0]!.point, hostTrap.geometry.exits.points[0]!.point);
  strictEqual(fallthrough.needs[0]!.point, fallthrough.geometry.exits.points[0]!.point);
});

test("state obligations create concrete value needs and skip undefined flags", () => {
  const { timelineUses, needs, obligations, valueNeedByObligation } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x22) },
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) },
        AF: { kind: "undef" }
      }
    },
    { op: "next" }
  ]);

  deepStrictEqual(needSummaries(needs, timelineUses), [
    {
      origin: {
        kind: "state-obligation-value",
        obligation: obligations[0]!.id
      },
      expr: exprConst(0x22)
    },
    {
      origin: {
        kind: "state-obligation-value",
        obligation: obligations[1]!.id
      },
      expr: exprConst(1)
    }
  ]);
  strictEqual(needs[0]!.point, obligations[0]!.point);
  strictEqual(needs[1]!.point, obligations[1]!.point);
  strictEqual(valueNeedByObligation.get(obligations[0]!.id), needs[0]!.id);
  strictEqual(valueNeedByObligation.get(obligations[1]!.id), needs[1]!.id);
  strictEqual(valueNeedByObligation.has(obligations[2]!.id), false);
});

test("expression needs index timeline needs by canonical value-use id", () => {
  const { timelineUses, needs, timelineNeedByUse } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    }
  ]);
  const addressUse = timelineUses.all.find((use): use is Extract<TimelineValueUseIndex["all"][number], { kind: "action-input" }> =>
    use.kind === "action-input" && use.role === "address"
  )!;
  const addressNeed = needs.find((need) => need.expr === addressUse.expr)!;

  strictEqual(timelineUses.byId.get(addressUse.id), addressUse);
  strictEqual(timelineUses.bySite.get(addressUse.site)?.includes(addressUse), true);
  strictEqual(timelineNeedByUse.get(addressUse.id), addressNeed.id);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  geometry: ReturnType<typeof buildTimelineGeometry>;
  timelineUses: TimelineValueUseIndex;
  obligations: readonly StateObligation[];
  needs: readonly ExprNeed[];
  timelineNeedByUse: ExprNeeds["timelineNeedByUse"];
  valueNeedByObligation: ExprNeeds["valueNeedByObligation"];
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const timelineUses = buildTimelineValueUseIndex({ walked, geometry });
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ timelineUses, obligations });

  return {
    geometry,
    timelineUses,
    obligations: obligations.obligations,
    needs: needs.needs,
    timelineNeedByUse: needs.timelineNeedByUse,
    valueNeedByObligation: needs.valueNeedByObligation
  };
}

function needSummaries(
  needs: readonly ExprNeed[],
  timelineUses: TimelineValueUseIndex
): readonly unknown[] {
  return needs.map((need) => ({
    origin: originSummary(need.origin, timelineUses),
    expr: need.expr
  }));
}

function timelineUseForNeed(
  need: ExprNeed,
  timelineUses: TimelineValueUseIndex
): TimelineValueUseIndex["all"][number] {
  if (need.origin.kind !== "timeline-use") {
    throw new Error(`expression need ${need.id} is not a timeline use`);
  }

  return timelineUses.byId.get(need.origin.use) ??
    fail(`missing timeline use ${need.origin.use}`);
}

function originSummary(
  origin: ExprNeed["origin"],
  timelineUses: TimelineValueUseIndex
): unknown {
  switch (origin.kind) {
    case "timeline-use": {
      const use = timelineUses.byId.get(origin.use);

      if (use === undefined) {
        throw new Error(`missing timeline use ${origin.use}`);
      }

      switch (use.kind) {
        case "definition-input":
          return { kind: use.kind, role: use.role };
        case "action-input":
          return { kind: use.kind, role: use.role };
        case "exit-payload":
          return { kind: use.kind, edge: use.edge, role: use.role };
      }
    }
    case "state-obligation-value":
      return origin;
  }
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}

function fail(message: string): never {
  throw new Error(message);
}
