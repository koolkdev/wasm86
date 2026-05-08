import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import { IR_ALU_FLAG_MASK, IR_ALU_FLAG_MASKS } from "#x86/ir/model/flag-effects.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitMaterializedValueUses } from "#backends/wasm/jit/codegen/plan/materialized-values.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import type {
  JitCodegenPlan,
  JitInstructionEntryPoint,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { optimizeJitIrBlock } from "#backends/wasm/jit/optimization/optimize.js";
import { onlyExit, startAddress } from "../../../optimization/tests/helpers.js";

test("planJitCodegen records post-instruction fallthrough exits", () => {
  const instruction = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([instruction])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.FALLTHROUGH);
  const instructionState = codegenPlan.instructionStates[0]!;

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { regs: [], flagMask: 0 },
    { regs: ["eax"], flagMask: 0 }
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
  deepStrictEqual(exit.snapshot.committedRegs, ["eax"]);
  deepStrictEqual(exit.snapshot.speculativeRegs, []);
  strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, 0);
  deepStrictEqual(codegenPlan.materializationNeeds, [{
    value: { kind: "committedRegister", reg: "eax" },
    consumer: "registerExitStore",
    placement: {
      instructionIndex: exit.instructionIndex,
      opIndex: exit.opIndex,
      exitPointIndex: 0,
      exitReason: ExitReason.FALLTHROUGH,
      exitMaterializationIndex: 1
    },
    pathScope: "deferredExit"
  }]);
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
  deepStrictEqual(exit.snapshot.committedRegs, ["eax"]);
  deepStrictEqual(exit.snapshot.speculativeRegs, []);
  strictEqual(exit.snapshot.speculativeFlags.mask, IR_ALU_FLAG_MASK);
  strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, IR_ALU_FLAG_MASK);
  deepStrictEqual(codegenPlan.materializationNeeds.filter((need) => need.placement.exitPointIndex === 0), [
    {
      value: { kind: "committedRegister", reg: "eax" },
      consumer: "registerExitStore",
      placement: {
        instructionIndex: exit.instructionIndex,
        opIndex: exit.opIndex,
        exitPointIndex: 0,
        exitReason: ExitReason.MEMORY_READ_FAULT,
        exitMaterializationIndex: 1
      },
      pathScope: "deferredExit"
    },
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
  deepStrictEqual(writeFaults.map((exit) => exit.snapshot.committedRegs), [["eax"], ["eax"]]);
  strictEqual(writeFaults[0]!.exitMaterializationIndex !== writeFaults[1]!.exitMaterializationIndex, true);
  deepStrictEqual(writeFaults.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { regs: ["eax"], flagMask: 0 },
    { regs: ["eax"], flagMask: 0 }
  ]);
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
  deepStrictEqual(writeFault.snapshot.committedRegs, []);
  deepStrictEqual(writeFault.snapshot.speculativeRegs, []);
  strictEqual(writeFault.snapshot.speculativeFlags.mask, 0);
  strictEqual(codegenPlan.exitMaterializations[writeFault.exitMaterializationIndex]?.flagMask, 0);
});

test("planJitCodegen records exit materializations only for actual exit points", () => {
  const movEax = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const movEbx = ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], movEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEbx.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([movEax, movEbx, trap])));

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { regs: [], flagMask: 0 },
    { regs: ["eax", "ebx"], flagMask: 0 }
  ]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) =>
    entry.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0
  ), [0, 0, 0]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) => entry.exitPointCount), [0, 0, 1]);
});

test("planJitCodegen records flag materialization requirements before conditions and exits", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jb = ok(decodeBytes([0x72, 0x05], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, jb])));
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const conditionMaterialization = codegenPlan.flagMaterializationRequirements.find(
    (entry) => entry.reason === "condition"
  );
  const branchExits = codegenPlan.exitPoints.filter((entry) =>
    entry.exitReason === ExitReason.BRANCH_TAKEN || entry.exitReason === ExitReason.BRANCH_NOT_TAKEN
  );
  const branchExpressionBlock = emissionPlan.instructions[1]?.expressionBlock;
  const conditionalJumpIndex = branchExpressionBlock?.findIndex((op) => op.op === "conditionalJump") ?? -1;

  deepStrictEqual(conditionMaterialization, {
    instructionIndex: 1,
    opIndex: 0,
    reason: "condition",
    requiredMask: IR_ALU_FLAG_MASKS.CF,
    pendingMask: IR_ALU_FLAG_MASKS.CF
  });
  strictEqual(branchExits.length, 2);

  for (const exit of branchExits) {
    strictEqual(exit.snapshot.kind, "postInstruction");
    strictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex]?.flagMask, IR_ALU_FLAG_MASK);
  }

  strictEqual(conditionalJumpIndex > 0, true);
  strictEqual(branchExits[0]!.exitMaterializationIndex !== branchExits[1]!.exitMaterializationIndex, true);
  deepStrictEqual(branchExits.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { regs: ["eax"], flagMask: IR_ALU_FLAG_MASK },
    { regs: ["eax"], flagMask: IR_ALU_FLAG_MASK }
  ]);
  deepStrictEqual(
    codegenPlan.materializationNeeds
      .filter((need) =>
        need.placement.exitReason === ExitReason.BRANCH_TAKEN ||
        need.placement.exitReason === ExitReason.BRANCH_NOT_TAKEN
      )
      .map((need) => ({
        value: need.value,
        consumer: need.consumer,
        pathScope: need.pathScope,
        exitReason: need.placement.exitReason
      })),
    [
      {
        value: { kind: "committedRegister", reg: "eax" },
        consumer: "registerExitStore",
        pathScope: "taken",
        exitReason: ExitReason.BRANCH_TAKEN
      },
      {
        value: { kind: "exitFlags", mask: IR_ALU_FLAG_MASK },
        consumer: "flagExitStore",
        pathScope: "taken",
        exitReason: ExitReason.BRANCH_TAKEN
      },
      {
        value: { kind: "committedRegister", reg: "eax" },
        consumer: "registerExitStore",
        pathScope: "notTaken",
        exitReason: ExitReason.BRANCH_NOT_TAKEN
      },
      {
        value: { kind: "exitFlags", mask: IR_ALU_FLAG_MASK },
        consumer: "flagExitStore",
        pathScope: "notTaken",
        exitReason: ExitReason.BRANCH_NOT_TAKEN
      }
    ]
  );
  strictEqual(branchExpressionBlock?.some((op) => op.op === "flags.materialize" || op.op === "flags.boundary"), false);
});

test("planJitCodegen omits materialization needs for empty exits", () => {
  const trap = ok(decodeBytes([0xcd, 0x2e], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([trap])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);

  strictEqual(exit.exitMaterializationIndex, 0);
  deepStrictEqual(codegenPlan.exitMaterializations, [{ regs: [], flagMask: 0 }]);
  deepStrictEqual(codegenPlan.materializationNeeds, []);
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
  strictEqual((instruction?.valueCachePlan?.selectedValuesByEpoch.length ?? 0) > 0, true);
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
    exitMaterializations: [{ regs: [], flagMask: 0 }, { regs: ["eax"], flagMask: 0 }],
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
    exitMaterializations: [{ regs: [], flagMask: 0 }, { regs: ["eax"], flagMask: 0 }],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);

  strictEqual(emissionPlan.valueCachePlan, undefined);
});

test("buildJitCodegenEmissionPlan keeps flag boundaries out of expression blocks", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "boundary-before-materialization",
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
      instructionId: "boundary-before-materialization",
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
    materializationNeeds: [],
    exitMaterializations: [
      { regs: [], flagMask: 0 },
      { regs: [], flagMask: IR_ALU_FLAG_MASK },
      { regs: ["eax"], flagMask: 0 }
    ],
    maxExitMaterializationIndex: 2
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);
  const [instruction] = emissionPlan.instructions;

  if (instruction === undefined) {
    throw new Error("missing emission instruction");
  }

  const expressionBlock = instruction.expressionBlock;
  const materializedValueUsePlan = planJitMaterializedValueUses([{ expressionBlock }], plan);
  const setIndex = expressionBlock.findIndex((op) => op.op === "set" && op.role === "registerMaterialization");

  strictEqual(expressionBlock.some((op) => op.op === "flags.boundary"), false);
  strictEqual(setIndex !== -1, true);
  deepStrictEqual([...(materializedValueUsePlan.expressionUseIndexesByInstruction[0] ?? new Set())], [setIndex]);
});

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
  committedRegs: JitStateSnapshot["committedRegs"] = [],
  speculativeFlagMask = 0
): JitStateSnapshot {
  return {
    kind,
    eip,
    instructionCountDelta,
    committedRegs,
    speculativeRegs: [],
    committedFlags: { mask: 0 },
    speculativeFlags: { mask: speculativeFlagMask }
  };
}
