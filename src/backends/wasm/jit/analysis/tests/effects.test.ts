import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#backends/wasm/exit.js";
import {
  buildIrExpressionBlock,
} from "#backends/wasm/codegen/expressions.js";
import {
  type EffectInfo,
  type BlockEffectAnalysis
} from "#backends/wasm/jit/analysis/effects.js";
import { analyzeBlock } from "#backends/wasm/jit/analysis/block.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import {
  classifyEffect,
  classifyExits
} from "#backends/wasm/jit/analysis/effect-classifier.js";
import { branchPath, rootPath } from "#backends/wasm/jit/analysis/paths.js";
import {
  buildJitBoundExpressionBlock,
  type JitBoundExprBlock
} from "#backends/wasm/jit/ir/bound-expressions.js";
import { buildBlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type { JitIrInstruction } from "#backends/wasm/jit/ir/types.js";
import { c32, startAddress, syntheticInstruction, v } from "#backends/wasm/jit/ir/tests/helpers.js";

test("JIT effect classifier separates local state from ordered effects", () => {
  const localNext = syntheticInstruction([{ op: "next" }]);
  const finalNext = syntheticInstruction([{ op: "next" }], 0, "exit");
  const branch = syntheticInstruction([
    { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const localNextExpr = jitExpressionBlock(localNext);
  const finalNextExpr = jitExpressionBlock(finalNext);
  const branchExpr = jitExpressionBlock(branch);

  deepStrictEqual(classifyExits(localNextExpr[0]!, false), []);
  strictEqual(classifyEffect(localNextExpr[0]!, false), undefined);
  deepStrictEqual(classifyExits(finalNextExpr[0]!, true), ["fallthrough"]);
  strictEqual(classifyEffect(finalNextExpr[0]!, true), "fallthrough");
  deepStrictEqual(classifyExits(branchExpr[0]!, true), ["branchTaken", "branchNotTaken"]);
  strictEqual(classifyEffect(branchExpr[0]!, true), "branch");
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
  deepStrictEqual(exit?.payload, { kind: "static", value: startAddress + 1 });
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: startAddress + 1 });
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
  deepStrictEqual(effect.taken.path, branchPath(0, "taken"));
  deepStrictEqual(effect.notTaken.path, branchPath(0, "notTaken"));
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
  deepStrictEqual(exit?.visibleEip, { kind: "static", value: startAddress + 1 });
  deepStrictEqual(exit?.payload, { kind: "runtime", source: "hostTrapVector" });
  strictEqual(exit?.snapshot.progress.instructionCountDelta, 1);
});

function analyze(instructions: readonly JitIrInstruction[]): BlockEffectAnalysis {
  return analyzeBlock(buildBlockExpressions({ instructions })).effectAnalysis;
}

function jitExpressionBlock(instruction: JitIrInstruction): JitBoundExprBlock {
  return buildJitBoundExpressionBlock(buildIrExpressionBlock(instruction.ir), {
    eip: instruction.eip,
    nextEip: instruction.nextEip
  });
}

function effects(analysis: BlockEffectAnalysis): readonly EffectInfo[] {
  return analysis.effects;
}

function exits(analysis: BlockEffectAnalysis): readonly Exit[] {
  return analysis.exits;
}
