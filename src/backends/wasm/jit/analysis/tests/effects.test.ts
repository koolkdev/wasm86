import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#backends/wasm/exit.js";
import {
  buildIrExpressionBlockWithSourceMap
} from "#backends/wasm/codegen/expressions.js";
import {
  analyzeEffects,
  type EffectsAnalysis
} from "#backends/wasm/jit/analysis/effects.js";
import {
  classifyEffect,
  classifyExits,
  exitConditionValues,
  localConditionValues
} from "#backends/wasm/jit/analysis/effect-classifier.js";
import { buildInstructionPaths, branchPath, rootPath } from "#backends/wasm/jit/analysis/paths.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline.js";
import { indexProducedValues } from "#backends/wasm/jit/ir/produced-values.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { c32, syntheticInstruction, v } from "#backends/wasm/jit/ir/tests/helpers.js";

test("JIT effect classifier separates local state from ordered effects", () => {
  const localNext = syntheticInstruction([{ op: "next" }]);
  const finalNext = syntheticInstruction([{ op: "next" }], 0, "exit");
  const branch = syntheticInstruction([
    { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const select = syntheticInstruction([
    { op: "value.select", type: "i32", dst: v(1), condition: v(0), whenTrue: c32(1), whenFalse: c32(0) }
  ]);

  deepStrictEqual(classifyExits(localNext.ir[0]!, localNext), []);
  strictEqual(classifyEffect(localNext.ir[0]!, localNext), undefined);
  deepStrictEqual(classifyExits(finalNext.ir[0]!, finalNext), ["fallthrough"]);
  strictEqual(classifyEffect(finalNext.ir[0]!, finalNext), "fallthrough");
  deepStrictEqual(classifyExits(branch.ir[0]!, branch), ["branchTaken", "branchNotTaken"]);
  strictEqual(classifyEffect(branch.ir[0]!, branch), "branch");
  deepStrictEqual(localConditionValues(select.ir[0]!), [v(0)]);
  deepStrictEqual(exitConditionValues(branch.ir[0]!, branch), [v(0)]);
});

test("JIT effect analysis creates exact final fallthrough exits", () => {
  const instruction = syntheticInstruction([
    { op: "next" }
  ], 0, "exit");
  const analysis = analyze([instruction]);
  const [effect] = analysis.effects;
  const [exit] = analysis.exits;

  strictEqual(effect?.kind, "fallthrough");
  strictEqual(exit?.kind, "fallthrough");
  strictEqual(exit?.reason, ExitReason.FALLTHROUGH);
  deepStrictEqual(exit?.payload, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.path, rootPath());
  strictEqual(exit?.snapshot.instructionCountDelta, 1);
});

test("JIT effect analysis attaches exact branch exits with distinct paths", () => {
  const instruction = syntheticInstruction([
    { op: "conditionalJump", condition: c32(1), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const analysis = analyze([instruction]);
  const [effect] = analysis.effects;

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
  strictEqual(effect.taken.snapshot.instructionCountDelta, 1);
  strictEqual(effect.notTaken.snapshot.instructionCountDelta, 1);
});

test("JIT effect analysis owns memory guard exits without making stores exit", () => {
  const instruction = syntheticInstruction([
    { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "mem", address: c32(0x2000) }, value: c32(0x11) },
    { op: "set", target: { kind: "reg", reg: "ecx" }, value: c32(1) }
  ]);
  const analysis = analyze([instruction]);

  deepStrictEqual(analysis.effects.map((effect) => effect.kind), [
    "memoryGuard",
    "memoryStore"
  ]);
  strictEqual(analysis.exits.length, 1);

  const guard = analysis.effects[0];

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
  const [exit] = analysis.exits;

  strictEqual(analysis.effects[0]?.kind, "hostTrap");
  strictEqual(exit?.kind, "hostTrap");
  strictEqual(exit?.reason, ExitReason.HOST_TRAP);
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit?.payload, { kind: "runtime", source: "hostTrapVector" });
  strictEqual(exit?.snapshot.instructionCountDelta, 1);
});

function analyze(instructions: readonly JitInstruction[]): EffectsAnalysis {
  const analyses = [];
  let valueState = createJitValueState().snapshot();

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex]!;
    const expressionPlan = buildIrExpressionBlockWithSourceMap(instruction.ir);
    const valueTimeline = buildTimeline({
      operands: instruction.operands,
      expressions: expressionPlan.expressionBlock,
      entry: valueState,
      producedByVar: indexProducedValues(instruction, instructionIndex)
    });

    analyses.push({
      instruction,
      instructionIndex,
      sourceMap: expressionPlan.sourceMap,
      valueTimeline,
      paths: buildInstructionPaths(instruction, instructionIndex)
    });
    valueState = valueTimeline.final;
  }

  return analyzeEffects({ instructions: analyses });
}
