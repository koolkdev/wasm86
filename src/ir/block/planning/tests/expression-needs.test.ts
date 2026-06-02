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
  type ExprNeed,
  type ExprNeeds,
  type StateObligation
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
  const { geometry, needs } = analyzeBlock([
    {
      op: "set",
      target: { kind: "mem", address: c(0x1000) },
      value: c(0x55),
      accessWidth: 32
    }
  ]);
  const store = geometry.memory.writes[0]!;

  deepStrictEqual(needSummaries(needs), [
    { origin: { kind: "action-input" }, expr: exprConst(0x1000) },
    { origin: { kind: "action-input" }, expr: exprConst(0x55) }
  ]);
  strictEqual(needs[0]!.point, store.point);
  strictEqual(needs[1]!.point, store.point);
});

test("memory guard creates action-site and fault-exit address needs", () => {
  const { geometry, needs } = analyzeBlock([
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
  ]);
  const guard = geometry.memory.guards[0]!;

  deepStrictEqual(needSummaries(needs), [
    { origin: { kind: "action-input" }, expr: exprConst(0x1000) },
    { origin: { kind: "exit-payload" }, expr: exprConst(0x1000) }
  ]);
  strictEqual(needs[0]!.point, guard.point);
  strictEqual(needs[1]!.point, guard.faultExitPoint.point);
});

test("memory load creates address definition-input need", () => {
  const { geometry, needs } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    }
  ]);
  const load = geometry.definitions.points[0]!;

  deepStrictEqual(needSummaries(needs), [
    { origin: { kind: "definition-input" }, expr: exprConst(0x1000) }
  ]);
  strictEqual(needs[0]!.point, load.point);
});

test("dynamic register load and store create index and value needs", () => {
  const { geometry, needs } = analyzeBlock([
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

  deepStrictEqual(needSummaries(needs), [
    { origin: { kind: "definition-input" }, expr: exprConst(3) },
    { origin: { kind: "action-input" }, expr: exprConst(4) },
    { origin: { kind: "action-input" }, expr: exprConst(0x55) }
  ]);
  strictEqual(needs[0]!.point, load.point);
  strictEqual(needs[1]!.point, store.point);
  strictEqual(needs[2]!.point, store.point);
});

test("branch creates condition and path-specific exit payload needs", () => {
  const { geometry, needs } = analyzeBlock([
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

  deepStrictEqual(needSummaries(needs), [
    { origin: { kind: "action-input" }, expr: exprConst(1) },
    { origin: { kind: "exit-payload" }, expr: exprConst(0x40) },
    { origin: { kind: "exit-payload" }, expr: exprConst(0x44) }
  ]);
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

  deepStrictEqual(needSummaries(jump.needs), [
    { origin: { kind: "exit-payload" }, expr: exprConst(0x80) }
  ]);
  deepStrictEqual(needSummaries(hostTrap.needs), [
    { origin: { kind: "exit-payload" }, expr: exprConst(0x13) }
  ]);
  deepStrictEqual(needSummaries(fallthrough.needs), [
    { origin: { kind: "exit-payload" }, expr: exprConst(0x90) }
  ]);
  strictEqual(jump.needs[0]!.point, jump.geometry.exits.points[0]!.point);
  strictEqual(hostTrap.needs[0]!.point, hostTrap.geometry.exits.points[0]!.point);
  strictEqual(fallthrough.needs[0]!.point, fallthrough.geometry.exits.points[0]!.point);
});

test("state obligations create concrete value needs and skip undefined flags", () => {
  const { needs, obligations, valueNeedByObligation } = analyzeBlock([
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

  deepStrictEqual(needSummaries(needs), [
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

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  geometry: ReturnType<typeof buildTimelineGeometry>;
  obligations: readonly StateObligation[];
  needs: readonly ExprNeed[];
  valueNeedByObligation: ExprNeeds["valueNeedByObligation"];
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ walked, geometry, obligations });

  return {
    geometry,
    obligations: obligations.obligations,
    needs: needs.needs,
    valueNeedByObligation: needs.valueNeedByObligation
  };
}

function needSummaries(needs: readonly ExprNeed[]): readonly unknown[] {
  return needs.map((need) => ({
    origin: need.origin,
    expr: need.expr
  }));
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
