import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#backends/wasm/exit.js";
import { analyzeJitConditionUses } from "#backends/wasm/jit/ir/condition-uses.js";
import {
  indexJitEffects,
  jitConditionUseAt,
  jitConditionValuesAt,
  jitFirstOpIndexAfterPreInstructionExits,
  jitInstructionHasPreInstructionExit,
  jitLastPreInstructionExitOpIndex,
  jitPreInstructionExitReasonAt,
  jitPostInstructionExitsAt,
  jitRegisterWriteRegAt
} from "#backends/wasm/jit/ir/effects.js";
import {
  jitExitConditionValues,
  jitLocalConditionValues,
  jitPostInstructionExits
} from "#backends/wasm/jit/ir/effect-primitives.js";
import { c32, syntheticInstruction, v } from "./helpers.js";

test("JIT op effects identify post-instruction exits and condition values", () => {
  const fallthrough = syntheticInstruction([{ op: "next" }], 0, "exit");
  const localNext = syntheticInstruction([{ op: "next" }]);
  const localCondition = syntheticInstruction([
    { op: "value.select", type: "i32", dst: v(1), condition: v(0), whenTrue: c32(1), whenFalse: c32(0) },
    { op: "next" }
  ]);
  const branch = syntheticInstruction([
    { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
  ]);
  const branchOp = branch.ir[0]!;

  deepStrictEqual(jitPostInstructionExits(fallthrough.ir[0]!, fallthrough), [
    { kind: "fallthrough", exitReason: ExitReason.FALLTHROUGH }
  ]);
  deepStrictEqual(jitPostInstructionExits(localNext.ir[0]!, localNext), []);
  deepStrictEqual(jitPostInstructionExits(branchOp, branch), [
    { kind: "branchTaken", exitReason: ExitReason.JUMP },
    { kind: "branchNotTaken", exitReason: ExitReason.JUMP }
  ]);
  deepStrictEqual(jitLocalConditionValues(localCondition.ir[0]!), [v(0)]);
  deepStrictEqual(jitExitConditionValues(branchOp, branch), [v(0)]);
});

test("indexJitEffects indexes shared op effects", () => {
  const effects = indexJitEffects({
    instructions: [
      syntheticInstruction([
        { op: "flags.condition", dst: v(0), cc: "E" },
        { op: "value.select", type: "i32", dst: v(1), condition: v(0), whenTrue: c32(1), whenFalse: c32(0) },
        { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(1) },
        { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
      ]),
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ], 1)
    ]
  });

  deepStrictEqual(jitPostInstructionExitsAt(effects, 0, 3), [
    { kind: "branchTaken", exitReason: ExitReason.JUMP },
    { kind: "branchNotTaken", exitReason: ExitReason.JUMP }
  ]);
  deepStrictEqual(jitConditionValuesAt(effects, 0, 1, "localCondition"), [v(0)]);
  deepStrictEqual(jitConditionValuesAt(effects, 0, 3, "exitCondition"), [v(0)]);
  strictEqual(jitRegisterWriteRegAt(effects, 0, 2), "ecx");
  strictEqual(jitConditionUseAt(effects, 0, 0), "exitCondition");
  strictEqual(jitPreInstructionExitReasonAt(effects, 1, 0), ExitReason.MEMORY_READ_FAULT);
  strictEqual(jitInstructionHasPreInstructionExit(effects, 1), true);
  strictEqual(jitLastPreInstructionExitOpIndex(effects, 1), 0);
  strictEqual(jitFirstOpIndexAfterPreInstructionExits(effects, 0), 0);
  strictEqual(jitFirstOpIndexAfterPreInstructionExits(effects, 1), 1);
});

test("JIT effect helpers find the end of pre-instruction exits", () => {
  const effects = indexJitEffects({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        { op: "set", target: { kind: "mem", address: c32(0x2004) }, value: v(1) },
        { op: "next" }
      ])
    ]
  });

  strictEqual(jitLastPreInstructionExitOpIndex(effects, 0), 2);
  strictEqual(jitFirstOpIndexAfterPreInstructionExits(effects, 0), 3);
});

test("JIT condition use analysis rejects ordinary condition value uses", () => {
  throws(
    () => analyzeJitConditionUses({
      instructions: [
        syntheticInstruction([
          { op: "flags.condition", dst: v(0), cc: "E" },
          { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(0) },
          { op: "next" }
        ])
      ]
    }),
    /JIT condition value 0 is used as an ordinary value/
  );
});
