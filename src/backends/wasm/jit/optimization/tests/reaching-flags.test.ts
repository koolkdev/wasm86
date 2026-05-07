import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { IR_ALU_FLAG_MASK, IR_ALU_FLAG_MASKS } from "#x86/ir/model/flag-effects.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import {
  analyzeJitReachingFlags,
  singleReachingFlagProducer
} from "#backends/wasm/jit/optimization/analyses/reaching-flags.js";
import { c32, flagOwnerSummary, selectSet, startAddress, syntheticInstruction, v } from "./helpers.js";

test("reaching flags tracks partial flag producer ownership", () => {
  const analysis = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(1), b: c32(1) },
        createIrFlagSetOp("inc", { left: v(1), result: v(2) }),
        { op: "aluFlags.condition", dst: v(3), cc: "B" },
        { op: "conditionalJump", condition: v(3), taken: c32(0x2000), notTaken: c32(0x1001) }
      ])
    ]
  });
  const conditionRead = analysis.reads.find((read) => read.reason === "condition")!;
  const exitRead = analysis.reads.find((read) => read.reason === "exit")!;

  strictEqual(singleReachingFlagProducer(conditionRead)?.producer, "add");
  deepStrictEqual(flagOwnerSummary(conditionRead.owners), [
    { mask: IR_ALU_FLAG_MASKS.CF, kind: "producer", sourceId: 0, producer: "add" }
  ]);
  deepStrictEqual(flagOwnerSummary(exitRead.owners), [
    { mask: IR_ALU_FLAG_MASKS.CF, kind: "producer", sourceId: 0, producer: "add" },
    { mask: IR_ALU_FLAG_MASK & ~IR_ALU_FLAG_MASKS.CF, kind: "producer", sourceId: 1, producer: "inc" }
  ]);
});

test("reaching flags represents mixed-owner reads explicitly", () => {
  const analysis = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(1), b: c32(1) },
        createIrFlagSetOp("inc", { left: v(1), result: v(2) }),
        { op: "aluFlags.condition", dst: v(3), cc: "A" },
        ...selectSet(v(3), v(4)),
        { op: "next" }
      ])
    ]
  });
  const conditionRead = analysis.reads.find((read) => read.reason === "condition")!;

  strictEqual(singleReachingFlagProducer(conditionRead), undefined);
  deepStrictEqual(flagOwnerSummary(conditionRead.owners), [
    { mask: IR_ALU_FLAG_MASKS.CF, kind: "producer", sourceId: 0, producer: "add" },
    { mask: IR_ALU_FLAG_MASKS.ZF, kind: "producer", sourceId: 1, producer: "inc" }
  ]);
});

test("reaching flags records materialized owners and pre-instruction exit entry owners", () => {
  const analysis = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
        { op: "flags.materialize", mask: IR_ALU_FLAG_MASKS.ZF },
        { op: "get", dst: v(2), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ])
    ]
  });
  const materializeRead = analysis.reads.find((read) => read.reason === "materialize")!;
  const preExitRead = analysis.reads.find((read) => read.reason === "preInstructionExit")!;

  deepStrictEqual(flagOwnerSummary(materializeRead.owners), [
    { mask: IR_ALU_FLAG_MASKS.ZF, kind: "producer", sourceId: 0, producer: "add" }
  ]);
  deepStrictEqual(flagOwnerSummary(preExitRead.owners), [
    { mask: IR_ALU_FLAG_MASK, kind: "incoming" }
  ]);
  deepStrictEqual(flagOwnerSummary(analysis.finalOwners), [
    { mask: IR_ALU_FLAG_MASK & ~IR_ALU_FLAG_MASKS.ZF, kind: "producer", sourceId: 0, producer: "add" },
    { mask: IR_ALU_FLAG_MASKS.ZF, kind: "materialized" }
  ]);
});

test("reaching flags classifies local, exit-coupled, and unused condition reads", () => {
  const local = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "aluFlags.condition", dst: v(0), cc: "E" },
        ...selectSet(v(0), v(1)),
        { op: "next" }
      ])
    ]
  });
  const reusedExit = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "aluFlags.condition", dst: v(0), cc: "E" },
        ...selectSet(v(0), v(1)),
        { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
      ])
    ]
  });
  const unused = analyzeJitReachingFlags({
    instructions: [
      syntheticInstruction([
        { op: "aluFlags.condition", dst: v(0), cc: "E" },
        { op: "next" }
      ])
    ]
  });

  strictEqual(local.reads.find((read) => read.reason === "condition")?.conditionUse, "localCondition");
  strictEqual(reusedExit.reads.find((read) => read.reason === "condition")?.conditionUse, "exitCondition");
  strictEqual(unused.reads.find((read) => read.reason === "condition"), undefined);
});

test("reaching flags records pre-instruction memory fault reads from instruction entry owners", () => {
  const addMem = ok(decodeBytes([0x01, 0x18], startAddress));
  const analysis = analyzeJitReachingFlags(buildJitIrBlock([addMem]));
  const preInstructionExitReads = analysis.reads.filter((read) => read.reason === "preInstructionExit");
  const exitRead = analysis.reads.find((read) => read.reason === "exit");

  deepStrictEqual(preInstructionExitReads.map((read) => read.exitReason), [
    ExitReason.MEMORY_READ_FAULT,
    ExitReason.MEMORY_WRITE_FAULT
  ]);

  for (const read of preInstructionExitReads) {
    deepStrictEqual(flagOwnerSummary(read.owners), [
      { mask: IR_ALU_FLAG_MASK, kind: "incoming" }
    ]);
  }

  deepStrictEqual(flagOwnerSummary(exitRead?.owners ?? []), [
    { mask: IR_ALU_FLAG_MASK, kind: "producer", sourceId: 0, producer: "add" }
  ]);
});

test("reaching flags records producer input values", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const analysis = analyzeJitReachingFlags(buildJitIrBlock([add]));
  const source = analysis.sources[0]!;

  strictEqual(source.producer, "add");
  strictEqual(source.writtenMask, IR_ALU_FLAG_MASK);
  strictEqual(source.undefMask, 0);
  deepStrictEqual(source.inputs, {
    left: { kind: "value", value: { kind: "reg", reg: "eax" } },
    right: { kind: "value", value: { kind: "const", type: "i32", value: 1 } },
    result: {
      kind: "value",
      value: {
        kind: "value.binary", type: "i32", operator: "add",
        a: { kind: "reg", reg: "eax" },
        b: { kind: "const", type: "i32", value: 1 }
      }
    }
  });
  deepStrictEqual(source.readRegs, ["eax"]);
});
