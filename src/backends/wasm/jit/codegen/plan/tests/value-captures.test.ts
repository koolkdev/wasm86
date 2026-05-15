import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import type {
  BranchPaths,
  PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import { planJitValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { cacheSelectionUsesForPlannedUse } from "#backends/wasm/jit/codegen/plan/value-cache-uses.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline.js";
import { planJitValueUses } from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { planJitValueCaptures } from "#backends/wasm/jit/codegen/plan/value-captures.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import {
  jitInputReg32Value,
  jitProducedValue
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  addExpr,
  addValue,
  branchPath,
  c32,
  c32Expr,
  rootPath
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
  const targetUses = uses.filter((use) => valuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.path), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
  strictEqual(captures.length, 1);
  strictEqual(valuesEqual(captures[0]!.value, expected), true);
  deepStrictEqual(captures[0]!.placement, { instructionIndex: 0, opIndex: 0, epoch: 0 });
  deepStrictEqual(captures[0]!.availabilityPath, rootPath());
  strictEqual(captures[0]!.consumers.length, 2);
});

test("JIT cache value uses carry flattened dependency ancestry for cache selection", () => {
  const target = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addExpr("eax", 1),
    b: c32Expr(0xff)
  } as const;
  const expressionBlock = [{
    op: "hostTrap",
    vector: target
  }] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });
  const expectedChild = addValue(jitInputReg32Value("eax"), c32(1));
  const expectedRoot = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: expectedChild,
    b: c32(0xff)
  } as const satisfies JitValue;
  const uses = planJitValueUses([{
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: defaultExpressionPaths(expressionBlock),
    materializationUses: new Map()
  }]);
  const rootUse = uses.find((use) => valuesEqual(use.value, expectedRoot));
  const cacheUses = uses.flatMap((use) => cacheSelectionUsesForPlannedUse(use));
  const childUse = cacheUses.find((use) => valuesEqual(use.value, expectedChild));

  if (rootUse === undefined || childUse === undefined) {
    throw new Error("expected planned root and cache child value uses");
  }

  deepStrictEqual(uses.filter((use) => valuesEqual(use.value, expectedChild)), []);
  deepStrictEqual(childUse.ancestors, [expectedRoot]);
  strictEqual(childUse.emittedCost > 0, true);
});

test("JIT value-capture planner keeps one-arm branch values path-specific", () => {
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
  const targetUses = uses.filter((use) => valuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.path), [
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
  const producedUses = uses.filter((use) => valuesEqual(use.value, produced));

  deepStrictEqual(cachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(captures, []);
  deepStrictEqual(producedUses.map((use) => use.path), [
    { kind: "path", id: "branch:0:1:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:1:notTaken", debugLabel: "notTaken" }
  ]);
});

test("JIT value-capture planner derives branch sharing from exit-store uses", () => {
  const expressionBlock = [{
    op: "conditionalJump",
    condition: c32Expr(1),
    taken: c32Expr(0x2000),
    notTaken: c32Expr(0x1002)
  }] as const satisfies IrExprBlock;
  const value = addValue(jitInputReg32Value("eax"), c32(1));
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });
  const materializationUses = new Map([[
    0,
    [
      { value, path: branchPath(0, 0, "taken"), purpose: "exitStore" },
      { value, path: branchPath(0, 0, "notTaken"), purpose: "exitStore" }
    ]
  ]]);
  const uses = planJitValueUses([{
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: defaultExpressionPaths(expressionBlock),
    materializationUses
  }]);
  const cachePlan = planJitValueCache({
    operands: [],
    valueTimeline: timeline
  }, expressionBlock, uses);
  const captures = planJitValueCaptures(uses, cachePlan);

  strictEqual(captures.length, 1);
  strictEqual(valuesEqual(captures[0]!.value, value), true);
  deepStrictEqual(captures[0]!.availabilityPath, rootPath());
  deepStrictEqual(captures[0]!.consumers.map((use) => use.path), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
});

function planCapturesForExpressionBlock(
  expressionBlock: IrExprBlock,
  producedByVar?: ReadonlyMap<number, JitProducedValue>
) {
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot(),
    ...(producedByVar === undefined ? {} : { producedByVar })
  });
  const uses = planJitValueUses([{
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: defaultExpressionPaths(expressionBlock),
    materializationUses: new Map()
  }]);
  const cachePlan = planJitValueCache({
    operands: [],
    valueTimeline: timeline
  }, expressionBlock, uses);

  return { uses, cachePlan };
}

function defaultExpressionPaths(
  expressionBlock: IrExprBlock
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: branchPath(0, opIndex, "taken"),
        notTaken: branchPath(0, opIndex, "notTaken")
      });
    }
  }

  return paths;
}
