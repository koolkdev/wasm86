import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { analyzeJitConditionUses } from "#backends/wasm/jit/ir/condition-uses.js";
import {
  indexJitEffects,
  jitConditionUseAt,
  jitConditionValuesAt,
  jitOpExitsAt,
  jitRegisterWriteRegAt
} from "#backends/wasm/jit/ir/effects.js";
import {
  jitExitConditionValues,
  jitLocalConditionValues,
  jitOpExits
} from "#backends/wasm/jit/ir/effect-primitives.js";
import { c32, syntheticInstruction, v } from "./helpers.js";

test("JIT op effects identify exits and condition values", () => {
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

  deepStrictEqual(jitOpExits(fallthrough.ir[0]!, fallthrough), ["fallthrough"]);
  deepStrictEqual(jitOpExits(localNext.ir[0]!, localNext), []);
  deepStrictEqual(jitOpExits(branchOp, branch), ["branchTaken", "branchNotTaken"]);
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
        { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ], 1)
    ]
  });

  deepStrictEqual(jitOpExitsAt(effects, 0, 3), ["branchTaken", "branchNotTaken"]);
  deepStrictEqual(jitConditionValuesAt(effects, 0, 1, "localCondition"), [v(0)]);
  deepStrictEqual(jitConditionValuesAt(effects, 0, 3, "exitCondition"), [v(0)]);
  strictEqual(jitRegisterWriteRegAt(effects, 0, 2), "ecx");
  strictEqual(jitConditionUseAt(effects, 0, 0), "exitCondition");
  deepStrictEqual(jitOpExitsAt(effects, 1, 0), ["memoryReadFault"]);
  deepStrictEqual(jitOpExitsAt(effects, 1, 1), []);
});

test("JIT effect helpers index read and write guard exits at their own ops", () => {
  const effects = indexJitEffects({
    instructions: [
      syntheticInstruction([
        { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
        { op: "memory.guard", address: c32(0x2004), byteLength: 4, access: "write" },
        { op: "set", target: { kind: "mem", address: c32(0x2004) }, value: v(1) },
        { op: "next" }
      ])
    ]
  });

  deepStrictEqual(jitOpExitsAt(effects, 0, 0), ["memoryReadFault"]);
  deepStrictEqual(jitOpExitsAt(effects, 0, 3), ["memoryWriteFault"]);
  deepStrictEqual(jitOpExitsAt(effects, 0, 1), []);
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
