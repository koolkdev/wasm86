import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { Reg32 } from "#x86/isa/types.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitMaterializationUses } from "#backends/wasm/jit/codegen/plan/materialization-uses.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { planJitExpressionValueCacheForInstructions } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import type {
  JitCodegenPlan,
  JitExitMaterializationStore,
  JitExitPoint,
  JitInstructionEntryPoint,
  JitMaterializationNeed,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitProducedValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { optimizeJitIrBlock } from "#backends/wasm/jit/optimization/optimize.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { onlyExit, startAddress } from "../../../optimization/tests/helpers.js";

test("planJitCodegen records post-instruction fallthrough exits", () => {
  const instruction = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([instruction])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.FALLTHROUGH);
  const instructionState = codegenPlan.instructionStates[0]!;

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { stores: [], flagMask: 0 },
    { stores: [registerStore("eax", c32(1))], flagMask: 0 }
  ]);
  strictEqual(instructionState.entryPoint.instructionIndex, 0);
  strictEqual(instructionState.entryPoint.snapshot.kind, "preInstruction");
  strictEqual(instructionState.entryPoint.snapshot.eip, instruction.address);
  strictEqual(instructionState.entryPoint.preInstructionExitPlan, undefined);
  strictEqual(instructionState.exitPointCount, 1);
  strictEqual(exit.snapshot.kind, "postInstruction");
  strictEqual(exit.snapshot.eip, instruction.nextEip);
  strictEqual(exit.snapshot.instructionCountDelta, 1);
  strictEqual(exit.exitMaterializationIndex, 1);
  deepStrictEqual(exit.snapshot.valueState.regs.exitStores(), [registerStore("eax", c32(1))]);
  strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, 0);
  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(registerStore("eax", c32(1)), exit, 0)
  ]);
});

test("planJitCodegen keeps memory faults at pre-instruction snapshots", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const load = ok(decodeBytes([0x8b, 0x05, 0x00, 0x00, 0x01, 0x00], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, load])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_READ_FAULT);
  const loadInstructionState = codegenPlan.instructionStates[1]!;

  deepStrictEqual(codegenPlan.instructionStates.map((entry) =>
    entry.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0
  ), [0, 1]);
  strictEqual(loadInstructionState.entryPoint.instructionIndex, 1);
  strictEqual(loadInstructionState.entryPoint.snapshot.kind, "preInstruction");
  strictEqual(loadInstructionState.entryPoint.snapshot.eip, load.address);
  deepStrictEqual(loadInstructionState.entryPoint.preInstructionExitPlan, {
    exitPointCount: 1,
    preserveCommittedRegs: true
  });
  strictEqual(exit.instructionIndex, 1);
  strictEqual(exit.snapshot.kind, "preInstruction");
  strictEqual(exit.snapshot.eip, load.address);
  strictEqual(exit.snapshot.instructionCountDelta, 1);
  strictEqual(exit.exitMaterializationIndex, 1);
  deepStrictEqual(exit.snapshot.valueState.regs.exitStores(), [
    registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)))
  ]);
  strictEqual(exit.snapshot.speculativeFlags.mask, IR_ALU_FLAG_MASK);
  strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, IR_ALU_FLAG_MASK);
  deepStrictEqual(codegenPlan.materializationNeeds.filter((need) => need.placement.exitPointIndex === 0), [
    exitStoreNeed(registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1))), exit, 0),
    {
      value: { kind: "exitFlags", mask: IR_ALU_FLAG_MASK },
      consumer: "flagExitStore",
      placement: {
        instructionIndex: exit.instructionIndex,
        opIndex: exit.opIndex,
        exitPointIndex: 0,
        exitReason: ExitReason.MEMORY_READ_FAULT,
        exitMaterializationIndex: 1
      },
      pathScope: "deferredExit"
    }
  ]);
});

test("planJitCodegen keeps same-register-set exit materializations separate", () => {
  const movFirst = ok(decodeBytes([0xb8, 0x11, 0x11, 0x11, 0x11], startAddress));
  const firstFault = ok(decodeBytes([0x89, 0x1d, 0x00, 0x00, 0x01, 0x00], movFirst.nextEip));
  const movSecond = ok(decodeBytes([0xb8, 0x22, 0x22, 0x22, 0x22], firstFault.nextEip));
  const secondFault = ok(decodeBytes([0x89, 0x1d, 0x04, 0x00, 0x01, 0x00], movSecond.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([
    movFirst,
    firstFault,
    movSecond,
    secondFault
  ])));
  const writeFaults = codegenPlan.exitPoints.filter((exit) => exit.exitReason === ExitReason.MEMORY_WRITE_FAULT);

  strictEqual(writeFaults.length, 2);
  deepStrictEqual(writeFaults.map((exit) => exit.snapshot.valueState.regs.exitStores()), [
    [registerStore("eax", c32(0x1111_1111))],
    [registerStore("eax", c32(0x2222_2222))]
  ]);
  strictEqual(writeFaults[0]!.exitMaterializationIndex !== writeFaults[1]!.exitMaterializationIndex, true);
  deepStrictEqual(writeFaults.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { stores: [registerStore("eax", c32(0x1111_1111))], flagMask: 0 },
    { stores: [registerStore("eax", c32(0x2222_2222))], flagMask: 0 }
  ]);
});

test("planJitCodegen derives xchg exit stores from value-state snapshots", () => {
  const firstSwap = ok(decodeBytes([0x87, 0xd8], startAddress));
  const cancelSwap = ok(decodeBytes([0x87, 0xd8], firstSwap.nextEip));
  const remainingSwap = ok(decodeBytes([0x87, 0xd1], cancelSwap.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], remainingSwap.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([
    firstSwap,
    cancelSwap,
    remainingSwap,
    trap
  ])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);

  deepStrictEqual(exit.snapshot.valueState.regs.exitStores(), [
    registerStore("ecx", jitInputReg32Value("edx")),
    registerStore("edx", jitInputReg32Value("ecx"))
  ]);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [
      registerStore("ecx", jitInputReg32Value("edx")),
      registerStore("edx", jitInputReg32Value("ecx"))
    ],
    flagMask: 0
  });
});

test("planJitCodegen excludes current-instruction speculative writes from memory fault snapshots", () => {
  const instruction = ok(decodeBytes([0x01, 0x18], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([instruction])));
  const instructionState = codegenPlan.instructionStates[0]!;
  const writeFault = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_WRITE_FAULT);

  deepStrictEqual(instructionState.entryPoint.preInstructionExitPlan, {
    exitPointCount: 2,
    preserveCommittedRegs: true
  });
  strictEqual(writeFault.snapshot.kind, "preInstruction");
  strictEqual(writeFault.snapshot.eip, instruction.address);
  strictEqual(writeFault.snapshot.instructionCountDelta, 0);
  strictEqual(writeFault.exitMaterializationIndex, 0);
  deepStrictEqual(writeFault.snapshot.valueState.regs.exitStores(), []);
  strictEqual(writeFault.snapshot.speculativeFlags.mask, 0);
  strictEqual(codegenPlan.exitMaterializations[writeFault.exitMaterializationIndex]?.flagMask, 0);
});

test("planJitCodegen keeps same-instruction writes out of later pre-instruction faults", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "write-before-fault",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "value.const", type: "i32", dst: { kind: "var", id: 0 }, value: 0x1234 },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 0 },
          accessWidth: 32
        },
        {
          op: "get",
          dst: { kind: "var", id: 1 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x10000 } },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const readFault = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_READ_FAULT);
  const hostTrap = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);

  strictEqual(readFault.snapshot.kind, "preInstruction");
  strictEqual(readFault.exitMaterializationIndex, 0);
  deepStrictEqual(readFault.snapshot.valueState.regs.exitStores(), []);
  strictEqual(hostTrap.snapshot.kind, "postInstruction");
  strictEqual(hostTrap.exitMaterializationIndex, 1);
  deepStrictEqual(hostTrap.snapshot.valueState.regs.exitStores(), [registerStore("eax", c32(0x1234))]);
});

test("planJitCodegen records exit materializations only for actual exit points", () => {
  const movEax = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const movEbx = ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], movEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEbx.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([movEax, movEbx, trap])));

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { stores: [], flagMask: 0 },
    { stores: [registerStore("eax", c32(1)), registerStore("ebx", c32(2))], flagMask: 0 }
  ]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) =>
    entry.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0
  ), [0, 0, 0]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) => entry.exitPointCount), [0, 0, 1]);
});

test("planJitCodegen records flag materialization requirements for branch exits", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jb = ok(decodeBytes([0x72, 0x05], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, jb])));
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const branchExits = codegenPlan.exitPoints.filter((entry) =>
    entry.exitReason === ExitReason.BRANCH_TAKEN || entry.exitReason === ExitReason.BRANCH_NOT_TAKEN
  );
  const branchIr = codegenPlan.block.instructions[1]!.ir;
  const branchExpressionBlock = emissionPlan.instructions[1]?.expressionBlock;
  const conditionalJumpIndex = branchExpressionBlock?.findIndex((op) => op.op === "conditionalJump") ?? -1;

  strictEqual(branchIr.some((op) => op.op === "flags.condition"), true);
  strictEqual(branchExits.length, 2);

  for (const exit of branchExits) {
    strictEqual(exit.snapshot.kind, "postInstruction");
    strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, IR_ALU_FLAG_MASK);
  }

  strictEqual(conditionalJumpIndex > 0, true);
  strictEqual(branchExits[0]!.exitMaterializationIndex !== branchExits[1]!.exitMaterializationIndex, true);
  deepStrictEqual(branchExits.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { stores: [registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)))], flagMask: IR_ALU_FLAG_MASK },
    { stores: [registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)))], flagMask: IR_ALU_FLAG_MASK }
  ]);
  deepStrictEqual(
    codegenPlan.materializationNeeds
      .filter((need) =>
        need.consumer === "flagExitStore" &&
        (
          need.placement.exitReason === ExitReason.BRANCH_TAKEN ||
          need.placement.exitReason === ExitReason.BRANCH_NOT_TAKEN
        )
      )
      .map((need) => ({
        value: need.value,
        consumer: need.consumer,
        pathScope: need.pathScope,
        exitReason: need.placement.exitReason
      })),
    [
      {
        value: { kind: "exitFlags", mask: IR_ALU_FLAG_MASK },
        consumer: "flagExitStore",
        pathScope: "taken",
        exitReason: ExitReason.BRANCH_TAKEN
      },
      {
        value: { kind: "exitFlags", mask: IR_ALU_FLAG_MASK },
        consumer: "flagExitStore",
        pathScope: "notTaken",
        exitReason: ExitReason.BRANCH_NOT_TAKEN
      }
    ]
  );
});

test("planJitCodegen records full flag producers in value-state snapshots", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "full-flags",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "ebx" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 2 },
          a: { kind: "var", id: 0 },
          b: { kind: "var", id: 1 }
        },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 2 },
          accessWidth: 32
        },
        {
          op: "flags.set",
          producer: "add",
          writtenMask: IR_ALU_FLAG_MASK,
          undefMask: 0,
          inputs: {
            left: { kind: "var", id: 0 },
            right: { kind: "var", id: 1 },
            result: { kind: "var", id: 2 }
          }
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const result = addValue(eax, ebx);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), jitFlagProducerValue("add", {
    left: eax,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK }));
});

test("planJitCodegen records partial flag producers as symbolic masked inserts", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "partial-flags",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 1 },
          a: { kind: "var", id: 0 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 1 },
          accessWidth: 32
        },
        {
          op: "flags.set",
          producer: "inc",
          writtenMask: FLAG_PRODUCERS.inc.writtenMask,
          undefMask: 0,
          inputs: {
            left: { kind: "var", id: 0 },
            result: { kind: "var", id: 1 }
          }
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const eax = jitInputReg32Value("eax");
  const result = addValue(eax, c32(1));
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    FLAG_PRODUCERS.inc.writtenMask
  ));
});

test("planJitCodegen records effectful flag producer inputs as produced values", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "effectful-flag-input",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x1000 } },
          accessWidth: 32
        },
        { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "ebx" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 2 },
          a: { kind: "var", id: 0 },
          b: { kind: "var", id: 1 }
        },
        {
          op: "flags.set",
          producer: "add",
          writtenMask: IR_ALU_FLAG_MASK,
          undefMask: 0,
          inputs: {
            left: { kind: "var", id: 0 },
            right: { kind: "var", id: 1 },
            result: { kind: "var", id: 2 }
          }
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const produced = jitProducedValue("load#effectful-flag-input:0:0:0", "i32");
  const ebx = jitInputReg32Value("ebx");
  const result = addValue(produced, ebx);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), jitFlagProducerValue("add", {
    left: produced,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK }));
});

test("planJitCodegen fails loudly for unrepresentable flag producer inputs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "missing-flag-input",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "flags.set",
          producer: "add",
          writtenMask: IR_ALU_FLAG_MASK,
          undefMask: 0,
          inputs: {
            left: { kind: "var", id: 0 },
            right: { kind: "const", type: "i32", value: 1 },
            result: { kind: "const", type: "i32", value: 2 }
          }
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };

  throws(
    () => planJitCodegen(block),
    /could not resolve var 0 as a JIT value/
  );
});

test("planJitCodegen lets later full flag producers replace partial merges", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "partial-flags",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        operands: [],
        ir: [
          { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 1 },
            a: { kind: "var", id: 0 },
            b: { kind: "const", type: "i32", value: 1 }
          },
          {
            op: "set",
            target: { kind: "reg", reg: "eax" },
            value: { kind: "var", id: 1 },
            accessWidth: 32
          },
          {
            op: "flags.set",
            producer: "inc",
            writtenMask: FLAG_PRODUCERS.inc.writtenMask,
            undefMask: 0,
            inputs: {
              left: { kind: "var", id: 0 },
              result: { kind: "var", id: 1 }
            }
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "full-flags",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "exit",
        operands: [],
        ir: [
          { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "ecx" }, accessWidth: 32 },
          { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "edx" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 2 },
            a: { kind: "var", id: 0 },
            b: { kind: "var", id: 1 }
          },
          {
            op: "set",
            target: { kind: "reg", reg: "ecx" },
            value: { kind: "var", id: 2 },
            accessWidth: 32
          },
          {
            op: "flags.set",
            producer: "add",
            writtenMask: IR_ALU_FLAG_MASK,
            undefMask: 0,
            inputs: {
              left: { kind: "var", id: 0 },
              right: { kind: "var", id: 1 },
              result: { kind: "var", id: 2 }
            }
          },
          { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
        ]
      }
    ]
  };
  const codegenPlan = planJitCodegen(block);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const ecx = jitInputReg32Value("ecx");
  const edx = jitInputReg32Value("edx");
  const result = addValue(ecx, edx);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), jitFlagProducerValue("add", {
    left: ecx,
    right: edx,
    result
  }, { mask: IR_ALU_FLAG_MASK }));
});

test("planJitCodegen records direct cmov conditions from current flag value state", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const cmove = ok(decodeBytes([0x0f, 0x44, 0xd1], cmp.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], cmove.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([cmp, cmove, trap])));
  const cmpInstruction = codegenPlan.block.instructions[0]!;
  const cmoveInstruction = codegenPlan.block.instructions[1]!;
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const currentFlags = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: subValue(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASK });
  const selectedEdx = {
    kind: "value.select",
    type: "i32",
    condition: jitFlagConditionValue(currentFlags, "E"),
    whenTrue: jitInputReg32Value("ecx"),
    whenFalse: jitInputReg32Value("edx")
  } as const satisfies JitValue;

  strictEqual(cmpInstruction.ir.some((op) => op.op === "flags.set"), true);
  strictEqual(cmoveInstruction.ir.some((op) => op.op === "flags.condition"), true);
  deepStrictEqual(exit.snapshot.valueState.regs.exitStore("edx"), registerStore("edx", selectedEdx));
});

test("planJitCodegen omits materialization needs for empty exits", () => {
  const trap = ok(decodeBytes([0xcd, 0x2e], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([trap])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);

  strictEqual(exit.exitMaterializationIndex, 0);
  deepStrictEqual(codegenPlan.exitMaterializations, [{ stores: [], flagMask: 0 }]);
  deepStrictEqual(codegenPlan.materializationNeeds, []);
});

test("planJitCodegen feeds produced register exit-store values into materialization needs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "produced-exit-store",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x1000 } },
          accessWidth: 32
        },
        { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "ebx" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 2 },
          a: { kind: "var", id: 0 },
          b: { kind: "var", id: 1 }
        },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 2 },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const exitPointIndex = codegenPlan.exitPoints.indexOf(exit);
  const produced = jitProducedValue("load#produced-exit-store:0:0:0", "i32");
  const exitValue = addValue(produced, jitInputReg32Value("ebx"));

  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(registerStore("eax", exitValue), exit, exitPointIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.selectedUseCounts, [
    { value: produced, useCount: 1 }
  ]);
});

test("planJitCodegen keeps clobber-sensitive exit-store values symbolic in materialization needs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "clobber-sensitive-exit-store",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 1 },
          a: { kind: "var", id: 0 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "set",
          target: { kind: "reg", reg: "ebx" },
          value: { kind: "var", id: 1 },
          accessWidth: 32
        },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "const", type: "i32", value: 0 },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const clobberedInputValue = addValue(jitInputReg32Value("eax"), c32(1));

  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.stores, [
    registerStore("eax", c32(0)),
    registerStore("ebx", clobberedInputValue)
  ]);
  deepStrictEqual(
    codegenPlan.materializationNeeds.filter((need) => need.consumer === "registerExitStore"),
    [
      exitStoreNeed(registerStore("eax", c32(0)), exit, 0),
      exitStoreNeed(registerStore("ebx", clobberedInputValue), exit, 0)
    ]
  );
});

test("buildJitCodegenEmissionPlan prepares expression blocks and value-cache specs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "cache-plan",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 1 },
          a: { kind: "var", id: 0 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 3 },
          a: { kind: "var", id: 2 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "conditionalJump",
          condition: { kind: "const", type: "i32", value: 0 },
          taken: { kind: "var", id: 1 },
          notTaken: { kind: "var", id: 3 }
        }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const [instruction] = emissionPlan.instructions;

  strictEqual(instruction?.instructionId, "cache-plan");
  strictEqual(emissionPlan.exitPoints, codegenPlan.exitPoints);
  strictEqual(emissionPlan.materializationNeeds, codegenPlan.materializationNeeds);
  strictEqual(emissionPlan.exitMaterializations, codegenPlan.exitMaterializations);
  strictEqual(instruction?.expressionBlock.some((op) => op.op === "conditionalJump"), true);
  strictEqual((instruction?.valueCachePlan?.selectedUseCounts.length ?? 0) > 0, true);
  strictEqual((instruction?.valueCachePlan?.selectedConsumerValuesByEpoch.length ?? 0) > 0, true);
});

test("buildJitCodegenEmissionPlan does not count overwritten materializations as exit-store uses", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "materialize-before-overwrite",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        operands: [],
        ir: [
          { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 1 },
            a: { kind: "var", id: 0 },
            b: { kind: "const", type: "i32", value: 1 }
          },
          {
            op: "set",
            role: "registerMaterialization",
            target: { kind: "reg", reg: "eax" },
            value: { kind: "var", id: 1 }
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "overwrite-before-exit",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "exit",
        operands: [],
        ir: [
          {
            op: "set",
            target: { kind: "reg", reg: "eax" },
            value: { kind: "const", type: "i32", value: 0 },
            accessWidth: 32
          },
          { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
        ]
      }
    ]
  };
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [
      {
        instructionId: "materialize-before-overwrite",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        entryPoint: instructionEntryPoint(0, snapshot("preInstruction", startAddress, 0)),
        postInstructionState: snapshot("postInstruction", startAddress + 1, 1, ["eax"]),
        exitPointCount: 0
      },
      {
        instructionId: "overwrite-before-exit",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "exit",
        entryPoint: instructionEntryPoint(1, snapshot("preInstruction", startAddress + 1, 1, ["eax"])),
        postInstructionState: snapshot("postInstruction", startAddress + 2, 2, ["eax"]),
        exitPointCount: 1
      }
    ],
    exitPoints: [{
      instructionIndex: 1,
      opIndex: 1,
      exitReason: ExitReason.HOST_TRAP,
      snapshot: snapshot("postInstruction", startAddress + 2, 2, ["eax"]),
      exitMaterializationIndex: 1
    }],
    flagMaterializationRequirements: [],
    materializationNeeds: [],
    exitMaterializations: [{ stores: [], flagMask: 0 }, { stores: [registerStore("eax")], flagMask: 0 }],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);

  strictEqual(emissionPlan.valueCachePlan, undefined);
});

test("buildJitCodegenEmissionPlan does not count same-instruction later materializations for earlier exits", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "fault-before-materialization",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x10000 } },
          accessWidth: 32
        },
        { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 2 },
          a: { kind: "var", id: 1 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "set",
          role: "registerMaterialization",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 2 },
          accessWidth: 32
        },
        { op: "next" }
      ]
    }]
  };
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "fault-before-materialization",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
      entryPoint: instructionEntryPoint(0, snapshot("preInstruction", startAddress, 0, ["eax"]), {
        preInstructionExitPlan: {
          exitPointCount: 1,
          preserveCommittedRegs: true
        }
      }),
      postInstructionState: snapshot("postInstruction", startAddress + 1, 1, ["eax"]),
      exitPointCount: 1
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 0,
      exitReason: ExitReason.MEMORY_READ_FAULT,
      snapshot: snapshot("preInstruction", startAddress, 0, ["eax"]),
      exitMaterializationIndex: 1
    }],
    flagMaterializationRequirements: [],
    materializationNeeds: [],
    exitMaterializations: [{ stores: [], flagMask: 0 }, { stores: [registerStore("eax")], flagMask: 0 }],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);

  strictEqual(emissionPlan.valueCachePlan, undefined);
});

test("buildJitCodegenEmissionPlan maps exit-store uses at source exit locations past flag-only exits", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "flag-exit-before-materialization",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x10000 } },
          accessWidth: 32
        },
        { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 2 },
          a: { kind: "var", id: 1 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "set",
          role: "registerMaterialization",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 2 },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "flag-exit-before-materialization",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      entryPoint: instructionEntryPoint(0, snapshot("preInstruction", startAddress, 0, [], IR_ALU_FLAG_MASK), {
        preInstructionExitPlan: {
          exitPointCount: 1,
          preserveCommittedRegs: true
        }
      }),
      postInstructionState: snapshot("postInstruction", startAddress + 1, 1, ["eax"]),
      exitPointCount: 2
    }],
    exitPoints: [
      {
        instructionIndex: 0,
        opIndex: 0,
        exitReason: ExitReason.MEMORY_READ_FAULT,
        snapshot: snapshot("preInstruction", startAddress, 0, [], IR_ALU_FLAG_MASK),
        exitMaterializationIndex: 1
      },
      {
        instructionIndex: 0,
        opIndex: 4,
        exitReason: ExitReason.HOST_TRAP,
        snapshot: snapshot("postInstruction", startAddress + 1, 1, ["eax"]),
        exitMaterializationIndex: 2
      }
    ],
    flagMaterializationRequirements: [],
    materializationNeeds: [{
      consumer: "registerExitStore",
      target: { kind: "reg32", reg: "eax" },
      value: jitInputReg32Value("eax"),
      placement: {
        instructionIndex: 0,
        opIndex: 4,
        exitPointIndex: 1,
        exitReason: ExitReason.HOST_TRAP,
        exitMaterializationIndex: 2
      },
      pathScope: "deferredExit"
    }],
    exitMaterializations: [
      { stores: [], flagMask: 0 },
      { stores: [], flagMask: IR_ALU_FLAG_MASK },
      { stores: [registerStore("eax")], flagMask: 0 }
    ],
    maxExitMaterializationIndex: 2
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);
  const [instruction] = emissionPlan.instructions;

  if (instruction === undefined) {
    throw new Error("missing emission instruction");
  }

  const expressionBlock = instruction.expressionBlock;
  const materializationUsePlan = planJitMaterializationUses([{
    expressionBlock,
    sourceExpressionMap: instruction.sourceExpressionMap
  }], plan);
  const hostTrapIndex = expressionBlock.findIndex((op) => op.op === "hostTrap");
  const uses = materializationUsePlan.jitValueUsesByInstruction[0];

  strictEqual(hostTrapIndex !== -1, true);
  deepStrictEqual(uses?.get(hostTrapIndex), [jitInputReg32Value("eax")]);
});

test("JIT value-cache planning retains produced values needed after their definition", () => {
  const produced = jitProducedValue("load#cache-plan:0:0:0", "i32");
  const expressionBlock = [
    {
      op: "let32",
      dst: { kind: "var", id: 0 },
      value: {
        kind: "source",
        source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x1000 } },
        accessWidth: 32
      }
    },
    {
      op: "set",
      target: { kind: "reg", reg: "ebx" },
      value: { kind: "const", type: "i32", value: 0 },
      accessWidth: 32
    },
    {
      op: "set",
      role: "registerMaterialization",
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    }
  ] as const;
  const cachePlan = planJitExpressionValueCacheForInstructions([{
    operands: [],
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]]),
    materializationJitValueUsesByExpressionIndex: new Map([[2, [produced]]])
  }]);

  deepStrictEqual(cachePlan?.instructionPlans[0]?.valueRefValues.get(0), produced);
  deepStrictEqual(cachePlan?.instructionPlans[0]?.expressionValues.get(expressionBlock[0].value), produced);
  deepStrictEqual(cachePlan?.captureValuesByEpoch[0], [produced]);
  deepStrictEqual(cachePlan?.selectedConsumerValuesByEpoch[0], []);
  deepStrictEqual(cachePlan?.selectedConsumerValuesByEpoch[1], [{ value: produced, useCount: 1 }]);
  deepStrictEqual(cachePlan?.selectedUseCounts, [{ value: produced, useCount: 1 }]);
});

test("JIT value-cache planning resolves cold partial register reads with shared value rules", () => {
  const coldAl = {
    kind: "source",
    source: { kind: "reg", reg: "eax" },
    accessWidth: 8
  } as const;
  const expression = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: coldAl,
    b: { kind: "const", type: "i32", value: 0x12 }
  } as const;
  const expressionBlock = [{
    op: "conditionalJump",
    condition: { kind: "const", type: "i32", value: 1 },
    taken: expression,
    notTaken: expression
  }] as const;
  const cachePlan = planJitExpressionValueCacheForInstructions([{
    operands: [],
    expressionBlock
  }]);
  const expectedSource = jitExtractBits(jitInputReg32Value("eax"), 0, 8);
  const expectedExpression = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: expectedSource,
    b: c32(0x12)
  } as const;

  deepStrictEqual(cachePlan?.instructionPlans[0]?.expressionValues.get(coldAl), expectedSource);
  deepStrictEqual(cachePlan?.selectedUseCounts, [{ value: expectedExpression, useCount: 2 }]);
});

test("JIT value-cache planning merges repeated produced-value retained uses", () => {
  const produced = jitProducedValue("load#cache-plan:0:0:0", "i32");
  const expressionBlock = [
    {
      op: "let32",
      dst: { kind: "var", id: 0 },
      value: {
        kind: "source",
        source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x1000 } },
        accessWidth: 32
      }
    },
    {
      op: "set",
      role: "registerMaterialization",
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    },
    {
      op: "set",
      role: "registerMaterialization",
      target: { kind: "reg", reg: "edx" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    }
  ] as const;
  const cachePlan = planJitExpressionValueCacheForInstructions([{
    operands: [],
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]]),
    materializationJitValueUsesByExpressionIndex: new Map([[1, [produced]], [2, [produced]]])
  }]);

  deepStrictEqual(cachePlan?.selectedUseCounts, [{ value: produced, useCount: 2 }]);
});

test("JIT value-cache planning skips unused produced values", () => {
  const produced = jitProducedValue("load#cache-plan:0:0:0", "i32");
  const expressionBlock = [
    {
      op: "let32",
      dst: { kind: "var", id: 0 },
      value: {
        kind: "source",
        source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x1000 } },
        accessWidth: 32
      }
    },
    {
      op: "set",
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    }
  ] as const;
  const cachePlan = planJitExpressionValueCacheForInstructions([{
    operands: [],
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]])
  }]);

  strictEqual(cachePlan, undefined);
});

function registerStore(reg: Reg32, value: JitValue = jitInputReg32Value(reg)): JitExitMaterializationStore {
  return {
    target: { kind: "reg32", reg },
    value
  };
}

function exitStoreNeed(
  store: JitExitMaterializationStore,
  exitPoint: JitExitPoint,
  exitPointIndex: number
): JitMaterializationNeed {
  return {
    consumer: "registerExitStore",
    target: store.target,
    value: store.value,
    placement: {
      instructionIndex: exitPoint.instructionIndex,
      opIndex: exitPoint.opIndex,
      exitPointIndex,
      exitReason: exitPoint.exitReason,
      exitMaterializationIndex: exitPoint.exitMaterializationIndex
    },
    pathScope: exitPoint.exitReason === ExitReason.BRANCH_TAKEN
      ? "taken"
      : exitPoint.exitReason === ExitReason.BRANCH_NOT_TAKEN
        ? "notTaken"
        : "deferredExit"
  };
}

function instructionEntryPoint(
  instructionIndex: number,
  entrySnapshot: JitStateSnapshot,
  overrides: Partial<Pick<
    JitInstructionEntryPoint,
    "preInstructionExitPlan"
  >> = {}
): JitInstructionEntryPoint {
  return {
    instructionIndex,
    snapshot: entrySnapshot,
    ...overrides
  };
}

function snapshot(
  kind: JitStateSnapshot["kind"],
  eip: number,
  instructionCountDelta: number,
  changedRegs: readonly Reg32[] = [],
  speculativeFlagMask = 0
): JitStateSnapshot {
  const valueState = createJitValueState();

  for (const reg of changedRegs) {
    valueState.regs.writeReg32(reg, jitInputReg32Value(reg));
  }

  return {
    kind,
    eip,
    instructionCountDelta,
    valueState: valueState.snapshot(),
    committedFlags: { mask: 0 },
    speculativeFlags: { mask: speculativeFlagMask }
  };
}

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

function addValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function subValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}
