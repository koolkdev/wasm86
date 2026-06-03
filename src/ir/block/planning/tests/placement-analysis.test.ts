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
  analyzeBarrierFacts,
  analyzeExpressionNeeds,
  analyzePlacementPlan,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildTimelineGeometry,
  type PlacementPlan,
  type PlannedStateWrite,
  type StateWritePlacement,
  type StateWritePlan
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("PlacementPlan keeps overwritten fault-only writes in the fault exit path", () => {
  const { geometry, placement, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(2) },
    { op: "next" }
  ]);
  const memoryFault = geometry.exits.points.find((point) => point.exit.kind === "memoryFault")!;
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;
  const eax1 = eaxConstWrites(stateWrites, 1);
  const eax2 = eaxConstWrites(stateWrites, 2);

  strictEqual(eax1.length, 1);
  strictEqual(eax2.length, 1);
  strictEqual(writePlacement(placement, eax1[0]!).point, memoryFault.point);
  strictEqual(writePlacement(placement, eax2[0]!).point, fallthrough.point);
  strictEqual(
    writePlacements(placement).some((placed) =>
      placed.covers.includes(eax1[0]!.id) && placed.point.path.kind === "main"
    ),
    false
  );
});

test("PlacementPlan hoists unchanged writes needed by fault and normal exits", () => {
  const { geometry, placement, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "next" }
  ]);
  const guard = geometry.memory.guards[0]!;
  const guardBefore = geometry.points.bySite.get(guard.site)!.before;
  const eax1 = eaxConstWrites(stateWrites, 1);
  const placedWrites = writePlacements(placement);

  strictEqual(eax1.length, 2);
  strictEqual(placedWrites.length, 1);
  deepStrictEqual(placedWrites[0]!.covers, eax1.map((write) => write.id));
  strictEqual(placedWrites[0]!.representativeWrite, eax1[0]!.id);
  strictEqual(placedWrites[0]!.point, guardBefore);
  strictEqual(placedWrites[0]!.point.path, geometry.paths.root);
});

test("PlacementPlan emits register pre-state writes before a dynamic-register barrier", () => {
  const { geometry, placement, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(2), 32)]
    })
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const eax1 = eaxConstWrites(stateWrites, 1);

  strictEqual(eax1.length, 1);
  strictEqual(eax1[0]!.reason, "dynamic-register-store-pre-state");
  strictEqual(writePlacement(placement, eax1[0]!).point, dynamicStore.preStatePoint);
  strictEqual(writePlacement(placement, eax1[0]!).point.phase, "before");
  strictEqual(writePlacement(placement, eax1[0]!).point.at, dynamicStore.point.at);
});

test("PlacementPlan places saved expressions at their value-plan saveAt point", () => {
  const { placement, values } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
  ]);
  const saved = values.savedExprs[0]!;
  const savedPlacement = placement.saveExprs.find((placed) => placed.saved === saved.id);

  strictEqual(values.savedExprs.length, 1);
  strictEqual(savedPlacement?.point, saved.saveAt);
});

test("PlacementPlan does not mutate the semantic timeline", () => {
  const walked = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "next" }
    ]
  });
  const timelineBefore = [...walked.timeline];

  analyzeWalkedBlock(walked);

  strictEqual(walked.timeline.length, timelineBefore.length);
  for (let index = 0; index < timelineBefore.length; index += 1) {
    strictEqual(walked.timeline[index], timelineBefore[index]);
  }
  deepStrictEqual([...new Set(walked.timeline.map((site) => site.kind))].sort(), ["action"]);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): ReturnType<typeof analyzeWalkedBlock> {
  return analyzeWalkedBlock(walkExpressionBlock({ ...input, block }));
}

function analyzeWalkedBlock(walked: ReturnType<typeof walkExpressionBlock>): Readonly<{
  geometry: ReturnType<typeof buildTimelineGeometry>;
  placement: PlacementPlan;
  stateWrites: StateWritePlan;
  values: ReturnType<typeof analyzeValuePlan>;
}> {
  const geometry = buildTimelineGeometry(walked);
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ walked, geometry, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs, geometry, facts });
  const stateWrites = analyzeStateWrites({ obligations, needs, values });
  const placement = analyzePlacementPlan({
    geometry,
    facts,
    values,
    stateWrites
  });

  return {
    geometry,
    placement,
    stateWrites,
    values
  };
}

function writePlacements(
  placement: PlacementPlan
): readonly StateWritePlacement[] {
  return placement.stateWrites;
}

function writePlacement(
  placement: PlacementPlan,
  write: PlannedStateWrite
): StateWritePlacement {
  const found = writePlacements(placement).find((placed) => placed.covers.includes(write.id));

  if (found === undefined) {
    throw new Error(`write ${write.id} has no placement`);
  }

  return found;
}

function eaxConstWrites(stateWrites: StateWritePlan, value: number): readonly PlannedStateWrite[] {
  return stateWrites.writes.filter((write) =>
    write.target.kind === "reg" &&
    write.target.reg === registerAlias("eax") &&
    write.value?.kind === "inline" &&
    exprsEqual(write.value.expr, exprConst(value))
  );
}

function v(value: number): VarRef {
  return { kind: "var", id: value };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
