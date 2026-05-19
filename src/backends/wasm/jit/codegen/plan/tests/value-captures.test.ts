import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline-builder.js";
import { planCaptures } from "#backends/wasm/jit/codegen/plan/captures.js";
import { planReuseForInstructions } from "#backends/wasm/jit/codegen/plan/reuse.js";
import {
  branchExpressionPaths,
  valueUsesForExpressionBlock,
  type TestValueRoot
} from "#backends/wasm/jit/codegen/tests/value-use-test-helpers.js";
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
  buildBlock,
  buildJitCodegenEmissionPlan,
  c32,
  c32Expr,
  decodeBytes,
  exitPoint,
  exitState,
  ExitReason,
  ok,
  planJitCodegen,
  registerStore,
  rootPath,
  startAddress
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
  const { uses, reusePlan } = planCapturesForExpressionBlock(expressionBlock);
  const captures = reusePlan.captures.captures;
  const targetUses = uses.filter((use) => valuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.path), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
  strictEqual(captures.length, 1);
  strictEqual(valuesEqual(captures[0]!.value, expected), true);
  deepStrictEqual(captures[0]!.at, { instructionIndex: 0, opIndex: 0, epoch: 0 });
  deepStrictEqual(captures[0]!.availability, rootPath());
  strictEqual(captures[0]!.reason, "branchShared");
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
    entry: createJitValueState().snapshot(),
    snapshotPoints: new Set()
  });
  const expectedChild = addValue(jitInputReg32Value("eax"), c32(1));
  const expectedRoot = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: expectedChild,
    b: c32(0xff)
  } as const satisfies JitValue;
  const uses = valueUsesForExpressionBlock({
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: branchExpressionPaths(expressionBlock)
  });
  const rootUse = uses.find((use) => valuesEqual(use.value, expectedRoot));
  const childUse = uses.find((use) => valuesEqual(use.value, expectedChild));

  if (rootUse === undefined || childUse === undefined) {
    throw new Error("expected canonical root and child value uses");
  }

  deepStrictEqual(childUse.ancestors, [expectedRoot]);
  deepStrictEqual(childUse.root, expectedRoot);
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
  const { uses, reusePlan } = planCapturesForExpressionBlock(expressionBlock);
  const captures = reusePlan.captures.captures;
  const targetUses = uses.filter((use) => valuesEqual(use.value, expected));

  deepStrictEqual(targetUses.map((use) => use.path), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" }
  ]);
  deepStrictEqual(captures, []);
});

test("JIT value-capture planner captures used produced definitions with reason", () => {
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
  const { uses, reusePlan } = planCapturesForExpressionBlock(
    expressionBlock,
    new Map([[0, produced]])
  );
  const captures = reusePlan.captures.captures;
  const producedUses = uses.filter((use) => valuesEqual(use.value, produced));

  deepStrictEqual(captures.map((capture) => ({
    value: capture.value,
    at: capture.at,
    reason: capture.reason
  })), [{
    value: produced,
    at: { instructionIndex: 0, opIndex: 0, epoch: 0 },
    reason: "producedDefinition"
  }]);
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
    entry: createJitValueState().snapshot(),
    snapshotPoints: new Set()
  });
  const extraUses = new Map<number, readonly TestValueRoot[]>([[
    0,
    [
      { value, path: branchPath(0, 0, "taken"), purpose: "exitStore" },
      { value, path: branchPath(0, 0, "notTaken"), purpose: "exitStore" }
    ]
  ]]);
  const uses = valueUsesForExpressionBlock({
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: branchExpressionPaths(expressionBlock),
    extraUses
  });
  const reusePlan = planReuseForInstructions([{
    operands: [],
    valueTimeline: timeline,
    expressionBlock
  }], uses, []);
  const captures = reusePlan.captures.captures;

  strictEqual(captures.length, 1);
  strictEqual(valuesEqual(captures[0]!.value, value), true);
  deepStrictEqual(captures[0]!.availability, rootPath());
  strictEqual(captures[0]!.reason, "branchShared");
  deepStrictEqual(captures[0]!.consumers.map((use) => use.path), [
    { kind: "path", id: "branch:0:0:taken", debugLabel: "taken" },
    { kind: "path", id: "branch:0:0:notTaken", debugLabel: "notTaken" }
  ]);
});

test("JIT value-capture planner does not capture a selected store address without exit need", () => {
  const store = ok(decodeBytes([0x89, 0x44, 0x08, 0x04], startAddress)); // mov [eax + ecx + 4], eax
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(buildBlock([store])));

  strictEqual(emissionPlan.reusePlan.cache.selected.length > 0, true);
  deepStrictEqual(emissionPlan.reusePlan.captures.captures, []);
});

test("JIT value-capture planner explicitly captures selected cmov values for guard exits", () => {
  const cmove = ok(decodeBytes([0x0f, 0x44, 0xd1], startAddress)); // cmove edx, ecx
  const load = ok(decodeBytes([0x8b, 0x03], cmove.nextEip)); // mov eax, [ebx]
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(buildBlock([cmove, load])));
  const selected = emissionPlan.reusePlan.cache.selected
    .find((entry) => entry.value.kind === "value.select");

  if (selected === undefined) {
    throw new Error("expected selected cmov value");
  }

  const [capture] = emissionPlan.reusePlan.captures.captures
    .filter((candidate) =>
      candidate.reason === "forced" &&
        valuesEqual(candidate.value, selected.value)
    );

  if (capture === undefined) {
    throw new Error("expected forced cmov capture");
  }

  deepStrictEqual(capture.at, { instructionIndex: 1, opIndex: 0, epoch: 1 });
  deepStrictEqual(capture.availability, rootPath());
  deepStrictEqual(capture.consumers.map((consumer) => consumer.purpose), ["exitStore"]);
});

test("JIT value-capture planner keeps store-clobber consumers scoped to their exit placement", () => {
  const value = addValue(jitInputReg32Value("eax"), c32(1));
  const path = rootPath();
  const stores = [
    registerStore("eax", c32(0)),
    registerStore("ebx", value)
  ];
  const firstExit = exitPoint({
    instructionIndex: 0,
    opIndex: 0,
    reason: ExitReason.HOST_TRAP,
    snapshot: exitState(1),
    stores,
    exitStoreIndex: 1,
    path
  });
  const secondExit = exitPoint({
    instructionIndex: 0,
    opIndex: 1,
    reason: ExitReason.HOST_TRAP,
    snapshot: exitState(1),
    stores,
    exitStoreIndex: 2,
    path
  });
  const uses = [
    {
      value,
      at: { instructionIndex: 0, opIndex: 0, epoch: 0 },
      path,
      purpose: "exitStore",
      root: value,
      ancestors: [],
      exitId: firstExit.id
    },
    {
      value,
      at: { instructionIndex: 0, opIndex: 1, epoch: 1 },
      path,
      purpose: "exitStore",
      root: value,
      ancestors: [],
      exitId: secondExit.id
    }
  ] as const;
  const exits = [
    firstExit,
    secondExit
  ];
  const captures = planCaptures({
    uses,
    cache: {
      epochs: [],
      selected: [{ value, useCount: 2 }]
    },
    produced: [],
    exits
  }).captures;

  deepStrictEqual(captures.map((capture) => ({
    at: capture.at,
    consumers: capture.consumers.map((consumer) => consumer.at),
    reason: capture.reason
  })), [
    {
      at: uses[0].at,
      consumers: [uses[0].at],
      reason: "storeClobber"
    },
    {
      at: uses[1].at,
      consumers: [uses[1].at],
      reason: "storeClobber"
    }
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
    snapshotPoints: new Set(),
    ...(producedByVar === undefined ? {} : { producedByVar })
  });
  const uses = valueUsesForExpressionBlock({
    expressionBlock,
    valueTimeline: timeline,
    expressionPaths: branchExpressionPaths(expressionBlock)
  });
  const reusePlan = planReuseForInstructions([{
    operands: [],
    valueTimeline: timeline,
    expressionBlock
  }], uses, []);

  return { uses, reusePlan };
}
