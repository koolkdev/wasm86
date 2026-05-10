import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { IR_ALU_FLAG_MASK, IR_ALU_FLAG_MASKS } from "#x86/ir/model/flag-effects.js";
import { analyzeJitFlagLiveness } from "#backends/wasm/jit/optimization/analyses/flag-liveness.js";
import { runJitOptimizationPasses } from "#backends/wasm/jit/optimization/pass.js";
import { flagDcePass, pruneDeadJitFlagSets } from "#backends/wasm/jit/optimization/passes/flag-dce.js";
import { c32, selectSet, syntheticInstruction, v } from "./helpers.js";

test("flag-dce removes overwritten flag producers", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(1), b: c32(1) },
        createIrFlagSetOp("sub", { left: v(1), right: c32(1), result: v(2) }),
        { op: "flags.condition", dst: v(3), cc: "E" },
        ...selectSet(v(3), v(4)),
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 1);
  strictEqual(result.flagDce.retainedSetCount, 1);
  deepStrictEqual(flagProducerNames(result.block), ["sub"]);
});

test("flag-dce keeps partial flag producers needed by later CF reads", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(1), b: c32(1) },
        createIrFlagSetOp("inc", { left: v(1), result: v(2) }),
        { op: "flags.condition", dst: v(3), cc: "B" },
        { op: "conditionalJump", condition: v(3), taken: c32(0x2000), notTaken: c32(0x1001) }
      ])
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 0);
  strictEqual(result.flagDce.retainedSetCount, 2);
  deepStrictEqual(flagProducerNames(result.block), ["add", "inc"]);
});

test("flag-dce keeps producers needed by direct flag conditions", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "ebx" } },
        { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(0), b: v(1) },
        createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }),
        {
          op: "flagProducer.condition",
          dst: v(3),
          cc: "E",
          producer: "sub",
          writtenMask: IR_ALU_FLAG_MASK,
          undefMask: 0,
          inputs: { left: v(0), right: v(1) }
        },
        ...selectSet(v(3), v(4)),
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 0);
  strictEqual(result.flagDce.retainedSetCount, 1);
  deepStrictEqual(flagProducerNames(result.block), ["sub"]);
});

test("flag-dce keeps producers needed by memory fault and control exits", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "next" }
      ]),
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ], 1, "exit")
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 0);
  strictEqual(result.flagDce.retainedSetCount, 1);
  deepStrictEqual(flagProducerNames(result.block), ["add"]);
});

test("flag liveness applies pre-instruction fault reads at instruction entry", () => {
  const liveness = analyzeJitFlagLiveness({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "get", dst: v(2), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ])
    ]
  });

  strictEqual(liveness.instructions[0]?.entryReadMask, IR_ALU_FLAG_MASK);
  strictEqual(liveness.instructions[0]?.ops[2]?.keptFlagSet, false);
});

test("flag-dce keeps undefined bits needed by explicit boundaries", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "and", dst: v(1), a: v(0), b: c32(0xff) },
        createIrFlagSetOp("logic", { result: v(1) }),
        { op: "flags.boundary", mask: IR_ALU_FLAG_MASKS.AF },
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 0);
  strictEqual(result.flagDce.retainedSetCount, 1);
});

test("flag-dce keeps producers needed by explicit flag materialization", () => {
  const result = pruneDeadJitFlagSets({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "flags.materialize", mask: IR_ALU_FLAG_MASKS.ZF },
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.flagDce.removedSetCount, 0);
  strictEqual(result.flagDce.retainedSetCount, 1);
  deepStrictEqual(flagProducerNames(result.block), ["add"]);
});

test("flag-dce is a validating repeatable optimization pass", () => {
  const first = runJitOptimizationPasses({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "next" }
      ])
    ]
  }, [flagDcePass], { validate: true });
  const second = runJitOptimizationPasses(first.block, [flagDcePass], { validate: true });

  strictEqual(first.changed, true);
  deepStrictEqual(first.passes[0]?.stats, { removedSetCount: 1, retainedSetCount: 0 });
  strictEqual(second.changed, false);
  deepStrictEqual(second.passes[0]?.stats, { removedSetCount: 0, retainedSetCount: 0 });
});

function flagProducerNames(block: { instructions: readonly { ir: readonly { op: string; producer?: string }[] }[] }): readonly string[] {
  return block.instructions.flatMap((instruction) =>
    instruction.ir.flatMap((op) => op.op === "flags.set" ? [op.producer ?? ""] : [])
  );
}
