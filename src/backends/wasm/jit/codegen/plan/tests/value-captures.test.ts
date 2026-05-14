import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import type {
  JitBranchValuePathScopes,
  JitControlPathScopesMap
} from "#backends/wasm/jit/codegen/plan/control-paths.js";
import { planJitExpressionValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import { buildJitPlannedValueUsesForInstructions } from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { planJitValueCaptures } from "#backends/wasm/jit/codegen/plan/value-captures.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import {
  jitInputReg32Value,
  jitProducedValue,
  jitValuesEqual,
  type JitProducedValue
} from "#backends/wasm/jit/ir/values.js";
import {
  addExpr,
  addValue,
  branchValuePathScope,
  c32,
  c32Expr,
  rootValuePathScope
} from "./plan-test-helpers.js";

test("JIT value-capture planner shares pure values needed by both branch paths", () => {
  const target = addExpr("eax", 1);
  const expressionBlock = [{
    op: "conditionalJump",
    condition: c32Expr(1),
    taken: target,
    notTaken: target
  }] as const satisfies IrExprBlock;
  const expected = addValue(jitInputReg32Value("eax"), c32(1));
  const { uses, cachePlan } = planCapturesForExpressionBlock(expressionBlock);
  const captures = planJitValueCaptures(uses, cachePlan);
  const targetUses = uses.filter((use) => jitValuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.pathScope), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
  strictEqual(captures.length, 1);
  strictEqual(jitValuesEqual(captures[0]!.value, expected), true);
  deepStrictEqual(captures[0]!.placement, { instructionIndex: 0, opIndex: 0, epoch: 0 });
  deepStrictEqual(captures[0]!.availabilityScope, rootValuePathScope());
  strictEqual(captures[0]!.consumers.length, 2);
});

test("JIT value-capture planner keeps one-arm branch values path-scoped", () => {
  const target = addExpr("eax", 1);
  const expressionBlock = [{
    op: "conditionalJump",
    condition: c32Expr(1),
    taken: target,
    notTaken: c32Expr(0)
  }] as const satisfies IrExprBlock;
  const expected = addValue(jitInputReg32Value("eax"), c32(1));
  const { uses, cachePlan } = planCapturesForExpressionBlock(expressionBlock);
  const captures = planJitValueCaptures(uses, cachePlan);
  const targetUses = uses.filter((use) => jitValuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.pathScope), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" }
  ]);
  deepStrictEqual(captures, []);
});

test("JIT value-capture planner leaves produced definitions to value-cache", () => {
  const produced = jitProducedValue("load#branch-capture:0:0:0", "i32");
  const expressionBlock = [
    {
      op: "let32",
      dst: { kind: "var", id: 0 },
      value: {
        kind: "source",
        source: { kind: "mem", address: c32Expr(0x1000) },
        accessWidth: 32
      }
    },
    {
      op: "conditionalJump",
      condition: c32Expr(1),
      taken: { kind: "var", id: 0 },
      notTaken: { kind: "var", id: 0 }
    }
  ] as const satisfies IrExprBlock;
  const { uses, cachePlan } = planCapturesForExpressionBlock(
    expressionBlock,
    new Map([[0, produced]])
  );
  const captures = planJitValueCaptures(uses, cachePlan);
  const producedUses = uses.filter((use) => jitValuesEqual(use.value, produced));

  deepStrictEqual(cachePlan?.captureValuesByEpoch[0], [produced]);
  deepStrictEqual(captures, []);
  deepStrictEqual(producedUses.map((use) => use.pathScope), [
    { kind: "path", id: "branch:0:1:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:1:notTaken", debugLabel: "notTaken" }
  ]);
});

test("JIT value-capture planner derives branch sharing from generic exit-store uses", () => {
  const expressionBlock = [{
    op: "conditionalJump",
    condition: c32Expr(1),
    taken: c32Expr(0x2000),
    notTaken: c32Expr(0x1002)
  }] as const satisfies IrExprBlock;
  const value = addValue(jitInputReg32Value("eax"), c32(1));
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });
  const materializationValueUsesByExpressionIndex = new Map([[
    0,
    [
      { value, pathScope: branchValuePathScope(0, 0, "taken"), purpose: "exitStore" },
      { value, pathScope: branchValuePathScope(0, 0, "notTaken"), purpose: "exitStore" }
    ]
  ]]);
  const cachePlan = planJitExpressionValueCache({
    operands: [],
    valueTimeline: timeline,
    materializationJitValueUsesByExpressionIndex: new Map([[0, [value, value]]])
  }, expressionBlock);
  const uses = buildJitPlannedValueUsesForInstructions([{
    expressionBlock,
    valueTimeline: timeline,
    expressionPathScopes: defaultPathScopesByExpressionIndex(expressionBlock),
    materializationValueUsesByExpressionIndex
  }]);
  const captures = planJitValueCaptures(uses, cachePlan);

  strictEqual(captures.length, 1);
  strictEqual(jitValuesEqual(captures[0]!.value, value), true);
  deepStrictEqual(captures[0]!.availabilityScope, rootValuePathScope());
  deepStrictEqual(captures[0]!.consumers.map((use) => use.pathScope), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
});

function planCapturesForExpressionBlock(
  expressionBlock: IrExprBlock,
  producedValuesByVarId?: ReadonlyMap<number, JitProducedValue>
) {
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot(),
    ...(producedValuesByVarId === undefined ? {} : { producedValuesByVarId })
  });
  const cachePlan = planJitExpressionValueCache({
    operands: [],
    valueTimeline: timeline
  }, expressionBlock);
  const uses = buildJitPlannedValueUsesForInstructions([{
    expressionBlock,
    valueTimeline: timeline,
    expressionPathScopes: defaultPathScopesByExpressionIndex(expressionBlock),
    materializationValueUsesByExpressionIndex: new Map()
  }]);

  return { uses, cachePlan };
}

function defaultPathScopesByExpressionIndex(
  expressionBlock: IrExprBlock
): JitControlPathScopesMap {
  const pathScopes = new Map<number, JitBranchValuePathScopes>();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      pathScopes.set(opIndex, {
        taken: branchValuePathScope(0, opIndex, "taken"),
        notTaken: branchValuePathScope(0, opIndex, "notTaken")
      });
    }
  }

  return pathScopes;
}
