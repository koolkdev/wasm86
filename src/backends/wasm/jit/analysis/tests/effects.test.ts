import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#backends/wasm/exit.js";
import {
  buildIrExpressionBlock,
  type IrExprBlock
} from "#backends/wasm/codegen/expressions.js";
import {
  analyzeInstructionEffects,
  timelineSnapshotPointsForExpressions,
  type EffectInfo,
  type EffectInstructionInput,
  type InstructionFlow
} from "#backends/wasm/jit/analysis/effects.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { instructionDeltaAfterOp } from "#backends/wasm/jit/analysis/instruction-progress.js";
import {
  classifyEffect,
  classifyExits
} from "#backends/wasm/jit/analysis/effect-classifier.js";
import { LoadResultRegistry } from "#backends/wasm/jit/analysis/load-result.js";
import { buildExpressionPaths, branchPath, rootPath } from "#backends/wasm/jit/analysis/paths.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline-builder.js";
import type { JitIrInstruction } from "#backends/wasm/jit/ir/types.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { c32, syntheticInstruction, v } from "#backends/wasm/jit/ir/tests/helpers.js";

test("JIT effect classifier separates local state from ordered effects", () => {
  const localNext = syntheticInstruction([{ op: "next" }]);
  const finalNext = syntheticInstruction([{ op: "next" }], 0, "exit");
  const branch = syntheticInstruction([
    { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const localNextExpr = buildIrExpressionBlock(localNext.ir);
  const finalNextExpr = buildIrExpressionBlock(finalNext.ir);
  const branchExpr = buildIrExpressionBlock(branch.ir);

  deepStrictEqual(classifyExits(localNextExpr[0]!, localNext), []);
  strictEqual(classifyEffect(localNextExpr[0]!, localNext), undefined);
  deepStrictEqual(classifyExits(finalNextExpr[0]!, finalNext), ["fallthrough"]);
  strictEqual(classifyEffect(finalNextExpr[0]!, finalNext), "fallthrough");
  deepStrictEqual(classifyExits(branchExpr[0]!, branch), ["branchTaken", "branchNotTaken"]);
  strictEqual(classifyEffect(branchExpr[0]!, branch), "branch");
});

test("JIT effect analysis creates exact final fallthrough exits", () => {
  const instruction = syntheticInstruction([
    { op: "next" }
  ], 0, "exit");
  const analysis = analyze([instruction]);
  const [effect] = effects(analysis);
  const [exit] = exits(analysis);

  strictEqual(effect?.kind, "fallthrough");
  strictEqual(exit?.kind, "fallthrough");
  strictEqual(exit?.reason, ExitReason.FALLTHROUGH);
  deepStrictEqual(exit?.payload, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.path, rootPath());
  strictEqual(exit?.snapshot.progress.instructionCountDelta, 1);
});

test("JIT effect analysis attaches exact branch exits with distinct paths", () => {
  const instruction = syntheticInstruction([
    { op: "conditionalJump", condition: c32(1), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const analysis = analyze([instruction]);
  const [effect] = effects(analysis);

  strictEqual(effect?.kind, "branch");

  if (effect?.kind !== "branch") {
    throw new Error("expected branch effect");
  }

  strictEqual(effect.taken.reason, ExitReason.JUMP);
  strictEqual(effect.notTaken.reason, ExitReason.JUMP);
  strictEqual(effect.taken.kind, "branchTaken");
  strictEqual(effect.notTaken.kind, "branchNotTaken");
  strictEqual(effect.taken.id !== effect.notTaken.id, true);
  deepStrictEqual(effect.taken.path, branchPath(0, 0, "taken"));
  deepStrictEqual(effect.notTaken.path, branchPath(0, 0, "notTaken"));
  strictEqual(effect.taken.snapshot.progress.instructionCountDelta, 1);
  strictEqual(effect.notTaken.snapshot.progress.instructionCountDelta, 1);
});

test("JIT effect analysis owns memory guard exits without making stores exit", () => {
  const instruction = syntheticInstruction([
    { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "mem", address: c32(0x2000) }, value: c32(0x11) },
    { op: "set", target: { kind: "reg", reg: "ecx" }, value: c32(1) }
  ]);
  const analysis = analyze([instruction]);
  const instructionEffects = effects(analysis);
  const instructionExits = exits(analysis);

  deepStrictEqual(instructionEffects.map((effect) => effect.kind), [
    "memoryGuard",
    "memoryStore"
  ]);
  strictEqual(instructionExits.length, 1);

  const guard = instructionEffects[0];

  if (guard?.kind !== "memoryGuard") {
    throw new Error("expected memory guard effect");
  }

  strictEqual(guard.faultExit.kind, "memoryReadFault");
  strictEqual(guard.faultExit.reason, ExitReason.MEMORY_READ_FAULT);
  deepStrictEqual(guard.faultExit.visibleEip, { kind: "static", value: instruction.eip });
  deepStrictEqual(guard.faultExit.payload, { kind: "runtime", source: "memoryAddress" });
});

test("JIT effect analysis records host traps with next-EIP visibility", () => {
  const instruction = syntheticInstruction([
    { op: "hostTrap", vector: c32(0x2e) }
  ]);
  const analysis = analyze([instruction]);
  const instructionEffects = effects(analysis);
  const [exit] = exits(analysis);

  strictEqual(instructionEffects[0]?.kind, "hostTrap");
  strictEqual(exit?.kind, "hostTrap");
  strictEqual(exit?.reason, ExitReason.HOST_TRAP);
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.payload, { kind: "runtime", source: "hostTrapVector" });
  strictEqual(exit?.snapshot.progress.instructionCountDelta, 1);
});

function analyze(instructions: readonly JitIrInstruction[]): readonly InstructionFlow[] {
  const flows: InstructionFlow[] = [];
  let valueState = createJitValueState().snapshot();
  let instructionCountDelta = 0;
  const loadResultRegistry = new LoadResultRegistry();

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex]!;
    const expressions = buildIrExpressionBlock(instruction.ir);
    const valueTimeline = buildTimeline({
      operands: instruction.operands,
      expressions,
      entry: valueState,
      snapshotPoints: timelineSnapshotPointsForExpressions(instruction, expressions),
      nextEip: instruction.nextEip,
      loadResultRegistry
    });

    const effectInput: EffectInstructionInput = {
      instruction,
      index: instructionIndex,
      expressions,
      timeline: valueTimeline,
      expressionPaths: buildExpressionPaths(expressions, instructionIndex),
      progress: {
        instructionCountDelta
      }
    };

    flows.push(analyzeInstructionEffects(effectInput));
    instructionCountDelta += instructionDeltaForExpressions(instruction, expressions);
    valueState = valueTimeline.finalState;
  }

  return flows;
}

function instructionDeltaForExpressions(
  instruction: JitIrInstruction,
  expressions: IrExprBlock
): number {
  let delta = 0;

  for (const op of expressions) {
    delta += instructionDeltaAfterOp(op, instruction);
  }

  return delta;
}

function effects(flows: readonly InstructionFlow[]): readonly EffectInfo[] {
  return flows.flatMap((flow) => flow.effects);
}

function exits(flows: readonly InstructionFlow[]): readonly Exit[] {
  return flows.flatMap((flow) => flow.exits);
}
