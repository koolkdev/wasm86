import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { analyzeJitConditionUses } from "#backends/wasm/jit/ir/condition-uses.js";
import {
  indexJitEffects,
  jitOpEffectsAt
} from "#backends/wasm/jit/ir/effects.js";
import {
  jitExitConditionValues,
  jitLocalConditionValues,
  jitOpOrderedEffectKind,
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
  strictEqual(jitOpOrderedEffectKind(fallthrough.ir[0]!, fallthrough), "exitEdge");
  strictEqual(jitOpOrderedEffectKind(localNext.ir[0]!, localNext), undefined);
  strictEqual(jitOpOrderedEffectKind(branchOp, branch), "controlTransfer");
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

  deepStrictEqual(jitOpEffectsAt(effects, 0, 3).exits, ["branchTaken", "branchNotTaken"]);
  strictEqual(jitOpEffectsAt(effects, 0, 3).orderedEffectKind, "controlTransfer");
  deepStrictEqual(jitOpEffectsAt(effects, 0, 1).localConditionValues, [v(0)]);
  deepStrictEqual(jitOpEffectsAt(effects, 0, 3).exitConditionValues, [v(0)]);
  strictEqual(jitOpEffectsAt(effects, 0, 2).registerWriteReg, "ecx");
  strictEqual(jitOpEffectsAt(effects, 0, 0).conditionUse, "exitCondition");
  deepStrictEqual(jitOpEffectsAt(effects, 1, 0).exits, ["memoryReadFault"]);
  strictEqual(jitOpEffectsAt(effects, 1, 0).orderedEffectKind, "memoryGuard");
  strictEqual(jitOpEffectsAt(effects, 1, 1).orderedEffectKind, "producedValueDefinition");
  deepStrictEqual(jitOpEffectsAt(effects, 1, 1).exits, []);
});

test("indexJitEffects indexes observable operation locations", () => {
  const effects = indexJitEffects({
    instructions: [
      syntheticInstruction([
        { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
        { op: "memory.guard", address: c32(0x2004), byteLength: 4, access: "write" },
        { op: "set", target: { kind: "reg", reg: "ecx" }, value: c32(1) },
        { op: "jump", target: c32(0x3000) }
      ], 0),
      syntheticInstruction([
        { op: "conditionalJump", condition: v(0), taken: c32(0x4000), notTaken: c32(0x4004) }
      ], 1),
      syntheticInstruction([
        { op: "hostTrap", vector: c32(0x2e) }
      ], 2),
      syntheticInstruction([
        { op: "next" }
      ], 3, "exit")
    ]
  });

  deepStrictEqual(jitOpEffectsAt(effects, 0, 0).exits, ["memoryReadFault"]);
  strictEqual(jitOpEffectsAt(effects, 0, 0).orderedEffectKind, "memoryGuard");
  deepStrictEqual(jitOpEffectsAt(effects, 0, 1).exits, ["memoryWriteFault"]);
  strictEqual(jitOpEffectsAt(effects, 0, 1).orderedEffectKind, "memoryGuard");
  strictEqual(jitOpEffectsAt(effects, 0, 2).registerWriteReg, "ecx");
  strictEqual(jitOpEffectsAt(effects, 0, 2).orderedEffectKind, undefined);
  deepStrictEqual(jitOpEffectsAt(effects, 0, 3).exits, ["jump"]);
  strictEqual(jitOpEffectsAt(effects, 0, 3).orderedEffectKind, "controlTransfer");
  deepStrictEqual(jitOpEffectsAt(effects, 1, 0).exits, ["branchTaken", "branchNotTaken"]);
  strictEqual(jitOpEffectsAt(effects, 1, 0).orderedEffectKind, "controlTransfer");
  deepStrictEqual(jitOpEffectsAt(effects, 2, 0).exits, ["hostTrap"]);
  strictEqual(jitOpEffectsAt(effects, 2, 0).orderedEffectKind, "hostTrap");
  deepStrictEqual(jitOpEffectsAt(effects, 3, 0).exits, ["fallthrough"]);
  strictEqual(jitOpEffectsAt(effects, 3, 0).orderedEffectKind, "exitEdge");
});

test("JIT effect index records explicit memory guard exits at their own ops", () => {
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

  deepStrictEqual(jitOpEffectsAt(effects, 0, 0).exits, ["memoryReadFault"]);
  deepStrictEqual(jitOpEffectsAt(effects, 0, 3).exits, ["memoryWriteFault"]);
  deepStrictEqual(jitOpEffectsAt(effects, 0, 1).exits, []);
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
