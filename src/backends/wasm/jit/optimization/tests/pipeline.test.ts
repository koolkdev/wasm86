import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { optimizeJitIrBlock } from "#backends/wasm/jit/optimization/optimize.js";
import {
  jitIrOptimizationPassOrder,
  runJitIrOptimizationPipeline
} from "#backends/wasm/jit/optimization/pipeline.js";
import type { JitOptimizationPass } from "#backends/wasm/jit/optimization/pass.js";
import { runJitOptimizationPasses } from "#backends/wasm/jit/optimization/pass.js";
import { startAddress, syntheticInstruction, v } from "./helpers.js";

test("runJitIrOptimizationPipeline exposes ordered transform results", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xorEax = ok(decodeBytes([0x83, 0xf0, 0x02], movEaxEcx.nextEip));
  const addEbxEax = ok(decodeBytes([0x01, 0xc3], xorEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], addEbxEax.nextEip));
  const result = runJitIrOptimizationPipeline(buildJitIrBlock([
    movEaxEcx,
    xorEax,
    addEbxEax,
    trap
  ]));

  deepStrictEqual(jitIrOptimizationPassOrder, [
    "localDce",
    "flagDce",
    "localDce"
  ]);
  deepStrictEqual(result.passResults.map((pass) => pass.name), jitIrOptimizationPassOrder);
  strictEqual(result.passResults.some((pass) => pass.changed), true);
  strictEqual(
    result.stats.localDce?.removedOpCount,
    result.passResults
      .filter((pass) => pass.name === "localDce")
      .reduce((total, pass) => total + (pass.stats.removedOpCount ?? 0), 0)
  );
  strictEqual(result.block.instructions.every((instruction) => !("prelude" in instruction)), true);
});

test("runJitIrOptimizationPipeline keeps flag conditions planning-visible through value state", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xorEax = ok(decodeBytes([0x83, 0xf0, 0x02], movEaxEcx.nextEip));
  const cmpEaxZero = ok(decodeBytes([0x83, 0xf8, 0x00], xorEax.nextEip));
  const cmoveEbxEdx = ok(decodeBytes([0x0f, 0x44, 0xda], cmpEaxZero.nextEip));
  const movEaxZero = ok(decodeBytes([0xb8, 0x00, 0x00, 0x00, 0x00], cmoveEbxEdx.nextEip));
  const xorEsi = ok(decodeBytes([0x31, 0xf6], movEaxZero.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], xorEsi.nextEip));
  const result = runJitIrOptimizationPipeline(buildJitIrBlock([
    movEaxEcx,
    xorEax,
    cmpEaxZero,
    cmoveEbxEdx,
    movEaxZero,
    xorEsi,
    trap
  ]));
  const cmpInstruction = result.block.instructions[2]!;
  const cmoveInstruction = result.block.instructions[3]!;

  strictEqual(result.stats["flagDce"]?.retainedSetCount, 2);
  strictEqual(cmpInstruction.ir.some((op) => op.op === "flags.set"), true);
  strictEqual(cmoveInstruction.ir.some((op) =>
    op.op === "set" && op.target.kind === "reg" && op.target.reg === "eax"
  ), false);
  strictEqual(cmoveInstruction.ir.some((op) => op.op === "flags.condition"), true);
});

test("runJitOptimizationPasses runs named IR-to-IR passes and validates pass output", () => {
  const appendConstPass: JitOptimizationPass = {
    name: "append-const",
    run(block) {
      return {
        block: {
          instructions: block.instructions.map((instruction) => ({
            ...instruction,
            ir: [
              { op: "value.const", type: "i32", dst: v(0), value: 7 },
              ...instruction.ir
            ]
          }))
        },
        changed: true,
        stats: { insertedOpCount: 1 }
      };
    }
  };

  const result = runJitOptimizationPasses({
    instructions: [syntheticInstruction([{ op: "next" }])]
  }, [appendConstPass], { validate: true });

  strictEqual(result.changed, true);
  deepStrictEqual(result.passes, [{
    name: "append-const",
    changed: true,
    stats: { insertedOpCount: 1 }
  }]);
  deepStrictEqual(result.block.instructions[0]?.ir.map((op) => op.op), ["value.const", "next"]);
});

test("runJitIrOptimizationPipeline exposes the new pass pipeline as plain JIT IR", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const cmove = ok(decodeBytes([0x0f, 0x44, 0xd1], cmp.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], cmove.nextEip));
  const result = runJitIrOptimizationPipeline(buildJitIrBlock([cmp, cmove, trap]), { validate: true });

  deepStrictEqual(jitIrOptimizationPassOrder, [
    "localDce",
    "flagDce",
    "localDce"
  ]);
  strictEqual(result.block.instructions.some((instruction) =>
    instruction.ir.some((op) => op.op === "flags.condition")
  ), true);
});

test("planJitCodegen keeps branch exit flag materialization separate from direct conditions", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const inc = ok(decodeBytes([0x40], add.nextEip));
  const je = ok(decodeBytes([0x74, 0x05], inc.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, inc, je])));
  const branchIr = codegenPlan.block.instructions[2]!.ir;

  strictEqual(branchIr.some((op) => op.op === "flags.condition"), true);
  deepStrictEqual(
    codegenPlan.flagMaterializationRequirements.map((requirement) => ({
      reason: requirement.reason,
      requiredMask: requirement.requiredMask,
      pendingMask: requirement.pendingMask
    })),
    [
      { reason: "exit", requiredMask: IR_ALU_FLAG_MASK, pendingMask: IR_ALU_FLAG_MASK },
      { reason: "exit", requiredMask: IR_ALU_FLAG_MASK, pendingMask: IR_ALU_FLAG_MASK }
    ]
  );
});
