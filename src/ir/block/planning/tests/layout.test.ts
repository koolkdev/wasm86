import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  analyzeBarrierFacts,
  analyzeExpressionNeeds,
  analyzePlacementPlan,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildBlockLayout,
  buildTimelineGeometry,
  buildTimelineValueUseIndex,
  type BlockLayout,
  type EdgePath,
  type LayoutRegion,
  type LayoutStep,
  type PlannedStateWrite,
  type StateWritePlan
} from "#ir/block/planning/index.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("BlockLayout keeps overwritten writes exit-local and leaves the timeline semantic-only", () => {
  const { geometry, layout, stateWrites, walked } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(2) },
    { op: "next" }
  ]);
  const eax1 = only(eaxConstWrites(stateWrites, 1));
  const faultRegion = layout.regions.find((region): region is EdgeLayoutRegion =>
    region.path.kind === "edge" &&
    geometry.edges.byPath.get(region.path)?.kind === "memory-fault"
  )!;

  strictEqual(walked.timeline.every((site) => site.kind === "action" || site.kind === "definition"), true);
  strictEqual(hasWrite(mainRegion(layout), eax1), false);
  strictEqual(hasWrite(faultRegion, eax1), true);
  deepStrictEqual(faultRegion.steps.map((step) => step.kind), ["write-state", "exit"]);
});

test("BlockLayout orders common-ancestor writes before the main action that can exit", () => {
  const { layout, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "next" }
  ]);
  const eax1 = eaxConstWrites(stateWrites, 1);
  const main = mainRegion(layout);
  strictEqual(eax1.length, 2);
  const writeStep = main.steps.find((step): step is Extract<LayoutStep, { kind: "write-state" }> =>
    step.kind === "write-state" && step.emit === eax1[0]!.id
  );
  const writeIndex = main.steps.findIndex((step) => step === writeStep);
  const guardIndex = main.steps.findIndex((step) =>
    step.kind === "action" && step.site.action.kind === "memoryGuard"
  );

  deepStrictEqual(writeStep?.satisfies, eax1.map((write) => write.id));
  strictEqual(guardIndex >= 0, true);
  strictEqual(writeIndex < guardIndex, true);
});

test("BlockLayout emits save-expr steps and wraps backend inputs as timeline inputs", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(1), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
  ]);
  const main = mainRegion(layout);
  const saveIndex = main.steps.findIndex((step) => step.kind === "save-expr");
  const firstStoreIndex = main.steps.findIndex((step) =>
    step.kind === "action" && step.site.action.kind === "memoryStore"
  );
  const definition = onlyStep(main, "definition");
  const stores = main.steps.filter((step): step is Extract<LayoutStep, { kind: "action" }> =>
    step.kind === "action" && step.site.action.kind === "memoryStore"
  );

  strictEqual(values.savedExprs.length, 1);
  strictEqual(saveIndex >= 0, true);
  strictEqual(saveIndex < firstStoreIndex, true);
  deepStrictEqual(definition.inputs.map((input) => input.use.kind), ["definition-input"]);
  deepStrictEqual(definition.inputs.map((input) => input.use.role), ["address"]);
  deepStrictEqual(stores[1]!.inputs.map((input) => input.use.role), ["address", "value"]);
  strictEqual(stores[1]!.inputs[1]!.recipe.kind, "saved-expr");
});

test("BlockLayout exposes branch edge regions and edge-owned exit payload inputs", () => {
  const { geometry, layout } = analyzeBlock([
    { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
  ]);
  const branchAction = only(mainRegion(layout).steps.filter((step): step is Extract<LayoutStep, { kind: "action" }> =>
    step.kind === "action" && step.site.action.kind === "branch"
  ));
  const payloadInputs = branchAction.inputs.filter((input) => input.use.kind === "exit-payload");
  const branchRegions = layout.regions.filter((region): region is EdgeLayoutRegion =>
    region.path.kind === "edge" &&
    geometry.edges.byPath.get(region.path)?.kind.startsWith("branch-") === true
  );

  deepStrictEqual(payloadInputs.map((input) => input.use.kind), ["exit-payload", "exit-payload"]);
  deepStrictEqual(payloadInputs.map((input) => input.use.role), ["target", "target"]);
  deepStrictEqual(payloadInputs.map((input) =>
    input.use.kind === "exit-payload" ? geometry.edges.byId.get(input.use.edge)?.kind : undefined
  ), ["branch-taken", "branch-not-taken"]);
  deepStrictEqual(branchRegions.map((region) => geometry.edges.byPath.get(region.path)?.kind), [
    "branch-taken",
    "branch-not-taken"
  ]);
  strictEqual(branchRegions.every((region) => region.steps.at(-1)?.kind === "exit"), true);
});

function analyzeBlock(block: IrBlock): Readonly<{
  walked: ReturnType<typeof walkExpressionBlock>;
  geometry: ReturnType<typeof buildTimelineGeometry>;
  values: ReturnType<typeof analyzeValuePlan>;
  stateWrites: StateWritePlan;
  layout: BlockLayout;
}> {
  const walked = walkExpressionBlock({ block });
  const geometry = buildTimelineGeometry(walked);
  const timelineUses = buildTimelineValueUseIndex({ walked, geometry });
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ timelineUses, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs: needs.needs, geometry, facts });
  const stateWrites = analyzeStateWrites({
    obligations,
    valueNeeds: needs.valueNeedByObligation,
    values
  });
  const placement = analyzePlacementPlan({ geometry, facts, values, stateWrites });

  return {
    walked,
    geometry,
    values,
    stateWrites,
    layout: buildBlockLayout({
      walked,
      geometry,
      timelineUses,
      timelineNeedByUse: needs.timelineNeedByUse,
      values,
      stateWrites,
      placement
    })
  };
}

function mainRegion(layout: BlockLayout): LayoutRegion {
  return layout.regions.find((region) => region.path.kind === "main")!;
}

type EdgeLayoutRegion = LayoutRegion & Readonly<{ path: EdgePath }>;

function hasWrite(region: LayoutRegion, write: PlannedStateWrite): boolean {
  return region.steps.some((step) => step.kind === "write-state" && step.satisfies.includes(write.id));
}

function onlyStep<TKind extends LayoutStep["kind"]>(
  region: LayoutRegion,
  kind: TKind
): Extract<LayoutStep, { kind: TKind }> {
  const steps = region.steps.filter((step): step is Extract<LayoutStep, { kind: TKind }> =>
    step.kind === kind
  );

  strictEqual(steps.length, 1);
  return steps[0]!;
}

function only<TValue>(values: readonly TValue[]): TValue {
  strictEqual(values.length, 1);
  return values[0]!;
}

function eaxConstWrites(stateWrites: StateWritePlan, value: number): readonly PlannedStateWrite[] {
  return stateWrites.writes.filter((write) =>
    write.target.kind === "reg" &&
    write.target.reg === registerAlias("eax") &&
    write.value?.kind === "inline" &&
    exprsEqual(write.value.expr, exprConst(value))
  );
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
