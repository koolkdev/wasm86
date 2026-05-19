import {
  deepStrictEqual,
  strictEqual,
  throws,
  test,
  ok,
  decodeBytes,
  IR_ALU_FLAG_MASK,
  FLAG_PRODUCERS,
  ExitReason,
  buildBlock,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitLoadResultValue,
  onlyExit,
  startAddress,
  registerStore,
  flagStore,
  plannedRegisterStores,
  plannedFlagStores,
  c32,
  addValue,
  subValue,
  branchPath,
  rootPath,
  createJitValueState,
  type JitValue,
  type JitIrBlock,
} from "./plan-test-helpers.js";
import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import { storesForSnapshot } from "#backends/wasm/jit/codegen/plan/exit-stores.js";
import { registerStores } from "#backends/wasm/jit/codegen/plan/register-stores.js";
import { flagStores } from "#backends/wasm/jit/codegen/plan/flag-stores.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";

test("storesForSnapshot omits unchanged input register and flag stores", () => {
  const state = createJitValueState();

  state.regs.writeReg32("eax", jitInputReg32Value("eax"));
  state.flags.writeAluFlags(jitInputAluFlagsValue());

  deepStrictEqual(storesForSnapshot({
    progress: {
      instructionCountDelta: 0
    },
    valueState: state.snapshot()
  }), []);
});

test("registerStores derives full-register exit stores", () => {
  const state = createJitValueState();

  state.regs.writeReg32("eax", c32(0x1234_5678));

  deepStrictEqual(registerStores(state.snapshot()), [
    registerStore("eax", c32(0x1234_5678))
  ]);
});

test("registerStores derives low-byte exit stores", () => {
  const state = createJitValueState();

  state.regs.writeReg8("al", c32(0x7f));

  deepStrictEqual(registerStores(state.snapshot()), [{
    target: { kind: "reg8", reg: "al" },
    value: c32(0x7f)
  }]);
});

test("registerStores derives high-byte exit stores", () => {
  const state = createJitValueState();

  state.regs.writeReg8("ah", c32(0x7f));

  deepStrictEqual(registerStores(state.snapshot()), [{
    target: { kind: "reg8", reg: "ah" },
    value: c32(0x7f)
  }]);
});

test("registerStores derives word exit stores", () => {
  const state = createJitValueState();

  state.regs.writeReg16("ax", c32(0x7788));

  deepStrictEqual(registerStores(state.snapshot()), [{
    target: { kind: "reg16", reg: "ax" },
    value: c32(0x7788)
  }]);
});

test("registerStores omits prefix identity writes", () => {
  const state = createJitValueState();

  state.regs.writeReg8("al", state.regs.readReg8("al"));
  state.regs.writeReg8("bh", state.regs.readReg8("bh"));
  state.regs.writeReg16("cx", state.regs.readReg16("cx"));

  deepStrictEqual(registerStores(state.snapshot()), []);
});

test("flagStores derives partial flag exit stores", () => {
  const state = createJitValueState();
  const eax = jitInputReg32Value("eax");
  const result = addValue(eax, c32(1));
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const expected = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    FLAG_PRODUCERS.inc.writtenMask
  );

  state.flags.writeFlagBits(FLAG_PRODUCERS.inc.writtenMask, incFlags);

  deepStrictEqual(flagStores(state.snapshot()), [flagStore(expected)]);
});

test("flagStores lets later full flag writes replace partial merges", () => {
  const state = createJitValueState();
  const eax = jitInputReg32Value("eax");
  const incResult = addValue(eax, c32(1));
  const addResult = addValue(eax, jitInputReg32Value("ebx"));
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result: incResult
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const addFlags = jitFlagProducerValue("add", {
    left: eax,
    right: jitInputReg32Value("ebx"),
    result: addResult
  }, { mask: IR_ALU_FLAG_MASK });

  state.flags.writeFlagBits(FLAG_PRODUCERS.inc.writtenMask, incFlags);
  state.flags.writeFlagBits(IR_ALU_FLAG_MASK, addFlags);

  deepStrictEqual(flagStores(state.snapshot()), [flagStore(addFlags)]);
});

test("planJitCodegen records fallthrough exits at terminator ops", () => {
  const instruction = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const codegenPlan = planJitCodegen(buildBlock([instruction]));
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const exit = onlyExit(codegenPlan.exits, ExitReason.FALLTHROUGH);

  strictEqual(emissionPlan.instructions[0]?.exitCount, 1);
  strictEqual(exit.at.instructionIndex, 0);
  deepStrictEqual(exit.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit.payload, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit.path, rootPath());
  strictEqual("kind" in exit.snapshot, false);
  strictEqual("eip" in exit.snapshot, false);
  strictEqual(exit.snapshot.progress.instructionCountDelta, 1);
  strictEqual(exit.exitStoreIndex, 1);
  deepStrictEqual(plannedRegisterStores(exit), [registerStore("eax", c32(1))]);
});

test("planJitCodegen keeps memory guard faults at their op exit states", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const load = ok(decodeBytes([0x8b, 0x05, 0x00, 0x00, 0x01, 0x00], add.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([add, load]));
  const exit = onlyExit(codegenPlan.exits, ExitReason.MEMORY_READ_FAULT);
  const guardOpIndex = expressionOpIndex(
    codegenPlan.analysis.instructions[1]!.expressions,
    "memory.guard"
  );

  strictEqual(exit.at.instructionIndex, 1);
  strictEqual(exit.at.opIndex, guardOpIndex);
  deepStrictEqual(exit.visibleEip, { kind: "static", value: add.nextEip });
  deepStrictEqual(exit.payload, { kind: "runtime", source: "memoryAddress" });
  strictEqual(exit.snapshot.progress.instructionCountDelta, 1);
  strictEqual(exit.exitStoreIndex, 1);
  const expectedRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const expectedFlagStore = flagStore(exit.snapshot.valueState.flags.readAluFlags());

  deepStrictEqual(plannedRegisterStores(exit), [expectedRegisterStore]);
  deepStrictEqual(plannedFlagStores(exit), [expectedFlagStore]);
  deepStrictEqual(exit.stores, [expectedRegisterStore, expectedFlagStore]);
});

test("planJitCodegen keeps same-register-set exit stores separate", () => {
  const movFirst = ok(decodeBytes([0xb8, 0x11, 0x11, 0x11, 0x11], startAddress));
  const firstFault = ok(decodeBytes([0x89, 0x1d, 0x00, 0x00, 0x01, 0x00], movFirst.nextEip));
  const movSecond = ok(decodeBytes([0xb8, 0x22, 0x22, 0x22, 0x22], firstFault.nextEip));
  const secondFault = ok(decodeBytes([0x89, 0x1d, 0x04, 0x00, 0x01, 0x00], movSecond.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([
    movFirst,
    firstFault,
    movSecond,
    secondFault
  ]));
  const writeFaults = codegenPlan.exits.filter((exit) => exit.reason === ExitReason.MEMORY_WRITE_FAULT);

  strictEqual(writeFaults.length, 2);
  deepStrictEqual(writeFaults.map((exit) => plannedRegisterStores(exit)), [
    [registerStore("eax", c32(0x1111_1111))],
    [registerStore("eax", c32(0x2222_2222))]
  ]);
  strictEqual(writeFaults[0]!.exitStoreIndex !== writeFaults[1]!.exitStoreIndex, true);
  deepStrictEqual(writeFaults.map((exit) => exit.stores), [
    [registerStore("eax", c32(0x1111_1111))],
    [registerStore("eax", c32(0x2222_2222))]
  ]);
});

test("planJitCodegen derives xchg exit stores from value-state snapshots", () => {
  const firstSwap = ok(decodeBytes([0x87, 0xd8], startAddress));
  const cancelSwap = ok(decodeBytes([0x87, 0xd8], firstSwap.nextEip));
  const remainingSwap = ok(decodeBytes([0x87, 0xd1], cancelSwap.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], remainingSwap.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([
    firstSwap,
    cancelSwap,
    remainingSwap,
    trap
  ]));
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);

  deepStrictEqual(plannedRegisterStores(exit), [
    registerStore("ecx", jitInputReg32Value("edx")),
    registerStore("edx", jitInputReg32Value("ecx"))
  ]);
  deepStrictEqual(exit.stores, [
    registerStore("ecx", jitInputReg32Value("edx")),
    registerStore("edx", jitInputReg32Value("ecx"))
  ]);
});

test("planJitCodegen excludes current-instruction speculative writes from memory fault exit state", () => {
  const instruction = ok(decodeBytes([0x01, 0x18], startAddress));
  const codegenPlan = planJitCodegen(buildBlock([instruction]));
  const writeFault = onlyExit(codegenPlan.exits, ExitReason.MEMORY_WRITE_FAULT);
  const guardOpIndex = expressionOpIndex(
    codegenPlan.analysis.instructions[0]!.expressions,
    "memory.guard",
    (op) => op.access === "write"
  );

  strictEqual(writeFault.at.opIndex, guardOpIndex);
  strictEqual(writeFault.snapshot.progress.instructionCountDelta, 0);
  strictEqual(writeFault.exitStoreIndex, 0);
  deepStrictEqual(plannedRegisterStores(writeFault), []);
});

test("planJitCodegen makes guard faults observe current op state", () => {
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
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x1000 },
          byteLength: 4,
          access: "read"
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const readFault = onlyExit(codegenPlan.exits, ExitReason.MEMORY_READ_FAULT);
  const hostTrap = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const expressionBlock = codegenPlan.analysis.instructions[0]!.expressions;
  const guardOpIndex = expressionOpIndex(expressionBlock, "memory.guard");
  const hostTrapOpIndex = expressionOpIndex(expressionBlock, "hostTrap");

  strictEqual(readFault.at.opIndex, guardOpIndex);
  deepStrictEqual(readFault.visibleEip, { kind: "static", value: startAddress });
  deepStrictEqual(readFault.payload, { kind: "runtime", source: "memoryAddress" });
  strictEqual(readFault.exitStoreIndex, 1);
  deepStrictEqual(plannedRegisterStores(readFault), [registerStore("eax", c32(0x1234))]);
  strictEqual(hostTrap.at.opIndex, hostTrapOpIndex);
  deepStrictEqual(hostTrap.visibleEip, { kind: "static", value: startAddress + 1 });
  deepStrictEqual(hostTrap.payload, { kind: "runtime", source: "hostTrapVector" });
  strictEqual(hostTrap.exitStoreIndex, 2);
  deepStrictEqual(plannedRegisterStores(hostTrap), [registerStore("eax", c32(0x1234))]);
});

test("planJitCodegen makes guard faults observe current flag state", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "flag-write-before-fault",
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
          op: "flags.set",
          producer: "inc",
          writtenMask: FLAG_PRODUCERS.inc.writtenMask,
          undefMask: 0,
          inputs: {
            left: { kind: "var", id: 0 },
            result: { kind: "var", id: 1 }
          }
        },
        {
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x10000 },
          byteLength: 4,
          access: "read"
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const readFault = onlyExit(codegenPlan.exits, ExitReason.MEMORY_READ_FAULT);
  const hostTrap = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const expressionBlock = codegenPlan.analysis.instructions[0]!.expressions;
  const guardOpIndex = expressionOpIndex(expressionBlock, "memory.guard");
  const hostTrapOpIndex = expressionOpIndex(expressionBlock, "hostTrap");
  const expectedFlags = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    jitFlagProducerValue("inc", {
      left: jitInputReg32Value("eax"),
      result: addValue(jitInputReg32Value("eax"), c32(1))
    }, { mask: FLAG_PRODUCERS.inc.writtenMask }),
    FLAG_PRODUCERS.inc.writtenMask
  );

  strictEqual(readFault.at.opIndex, guardOpIndex);
  strictEqual(readFault.exitStoreIndex, 1);
  deepStrictEqual(plannedFlagStores(readFault), [flagStore(expectedFlags)]);
  strictEqual(hostTrap.at.opIndex, hostTrapOpIndex);
  strictEqual(hostTrap.exitStoreIndex, 2);
  deepStrictEqual(plannedFlagStores(hostTrap), [flagStore(expectedFlags)]);
});

test("planJitCodegen records exit stores only for actual exit points", () => {
  const movEax = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const movEbx = ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], movEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEbx.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([movEax, movEbx, trap]));
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);

  strictEqual(exit.exitStoreIndex, 1);
  deepStrictEqual(exit.stores, [
    registerStore("eax", c32(1)),
    registerStore("ebx", c32(2))
  ]);
  deepStrictEqual(
    buildJitCodegenEmissionPlan(codegenPlan).instructions.map((entry) => entry.exitCount),
    [0, 0, 1]
  );
});

test("planJitCodegen records value-state-derived flag stores for branch exits", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jb = ok(decodeBytes([0x72, 0x05], add.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([add, jb]));
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const branchExits = codegenPlan.exits.filter((entry) =>
    entry.reason === ExitReason.JUMP && entry.path.id.startsWith("branch:")
  );
  const branchExpressionBlock = emissionPlan.instructions[1]?.analysis.expressions;
  const conditionalJumpIndex = branchExpressionBlock?.findIndex((op) => op.op === "conditionalJump") ?? -1;

  strictEqual(branchExpressionBlock?.some((op) =>
    op.op === "let32" && op.value.kind === "flags.condition"
  ), true);
  strictEqual(branchExits.length, 2);

  for (const exit of branchExits) {
    strictEqual(exit.at.instructionIndex, 1);
    deepStrictEqual(plannedFlagStores(exit), [
      flagStore(exit.snapshot.valueState.flags.readAluFlags())
    ]);
  }

  deepStrictEqual(branchExits[0]!.snapshot, branchExits[1]!.snapshot);
  deepStrictEqual(branchExits.map((exit) => exit.visibleEip), [
    { kind: "static", value: jb.nextEip + 5 },
    { kind: "static", value: jb.nextEip }
  ]);
  deepStrictEqual(branchExits.map((exit) => exit.payload), [
    { kind: "static", value: jb.nextEip + 5 },
    { kind: "static", value: jb.nextEip }
  ]);
  deepStrictEqual(branchExits.map((exit) => exit.path), [
    branchPath(1, branchExits[0]!.at.opIndex, "taken"),
    branchPath(1, branchExits[1]!.at.opIndex, "notTaken")
  ]);

  strictEqual(conditionalJumpIndex > 0, true);
  strictEqual(branchExits[0]!.exitStoreIndex !== branchExits[1]!.exitStoreIndex, true);
  const branchRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const branchFlagStore = flagStore(branchExits[0]!.snapshot.valueState.flags.readAluFlags());

  deepStrictEqual(branchExits.map((exit) => exit.stores), [
    [branchRegisterStore, branchFlagStore],
    [branchRegisterStore, branchFlagStore]
  ]);

  deepStrictEqual(
    emissionPlan.valueUses
      .filter((use) =>
        use.purpose === "exitStore" &&
        valuesEqual(use.value, branchFlagStore.value) &&
        use.path.id.startsWith("branch:")
      )
      .map((use) => ({
        value: use.value,
        purpose: use.purpose,
        path: use.path
      })),
    [
      {
        value: branchFlagStore.value,
        purpose: "exitStore",
        path: branchPath(1, branchExits[0]!.at.opIndex, "taken")
      },
      {
        value: branchFlagStore.value,
        purpose: "exitStore",
        path: branchPath(1, branchExits[1]!.at.opIndex, "notTaken")
      }
    ]
  );
});

test("buildJitCodegenEmissionPlan keeps branch path identity from expression IR", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "seed-eax",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        operands: [],
        ir: [
          {
            op: "set",
            target: { kind: "reg", reg: "eax" },
            value: { kind: "const", type: "i32", value: 0x44 },
            accessWidth: 32
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "folded-branch-path",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "exit",
        operands: [],
        ir: [
          { op: "flags.condition", dst: { kind: "var", id: 0 }, cc: "E" },
          { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "reg", reg: "ecx" }, accessWidth: 32 },
          {
            op: "conditionalJump",
            condition: { kind: "var", id: 0 },
            taken: { kind: "var", id: 1 },
            notTaken: { kind: "nextEip" }
          }
        ]
      }
    ]
  };
  const codegenPlan = planJitCodegen(block);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const branchInstruction = emissionPlan.instructions[1]!;
  const expressionBranchOpIndex = branchInstruction.analysis.expressions.findIndex((op) =>
    op.op === "conditionalJump"
  );
  const takenPath = branchPath(1, expressionBranchOpIndex, "taken");
  const takenTargetUse = emissionPlan.valueUses.find((use) =>
    use.purpose === "branchTarget" &&
      use.at.instructionIndex === 1 &&
      use.value.kind === "input" &&
      use.value.slot.kind === "reg32" &&
      use.value.slot.reg === "ecx"
  );
  const takenExitStoreUse = emissionPlan.valueUses.find((use) =>
    use.purpose === "exitStore" &&
      use.at.instructionIndex === 1 &&
      use.path.debugLabel === "taken"
  );

  deepStrictEqual(branchInstruction.analysis.expressions.map((op) => op.op), ["let32", "let32", "conditionalJump"]);
  strictEqual(expressionBranchOpIndex, 2);

  if (takenTargetUse === undefined) {
    throw new Error("expected taken branch target use");
  }

  if (takenExitStoreUse === undefined) {
    throw new Error("expected taken branch exit-store use");
  }

  strictEqual(takenTargetUse.at.instructionIndex, 1);
  strictEqual(takenTargetUse.at.opIndex, expressionBranchOpIndex);
  strictEqual(takenExitStoreUse.at.opIndex, expressionBranchOpIndex);
  deepStrictEqual(takenTargetUse.path, takenPath);
  deepStrictEqual(takenExitStoreUse.path, takenPath);
  deepStrictEqual(takenTargetUse.path, takenExitStoreUse.path);
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const result = addValue(eax, ebx);
  const expectedFlags = jitFlagProducerValue("add", {
    left: eax,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK });
  const expectedFlagStore = flagStore(expectedFlags);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(plannedFlagStores(exit), [expectedFlagStore]);
  deepStrictEqual(exit.stores, [
    registerStore("eax", result),
    expectedFlagStore
  ]);
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
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

test("planJitCodegen records effectful flag producer inputs as load-result values", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "effectful-flag-input",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x10000 },
          byteLength: 4,
          access: "read"
        },
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
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const loadResult = jitLoadResultValue(0, "i32");
  const ebx = jitInputReg32Value("ebx");
  const result = addValue(loadResult, ebx);
  const expectedFlags = jitFlagProducerValue("add", {
    left: loadResult,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK });
  const expectedFlagStore = flagStore(expectedFlags);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(exit.stores, [expectedFlagStore]);
  deepStrictEqual(
    emissionPlan.reusePlan.captures.captures
      .filter((capture) => capture.reason === "loadResultDefinition")
      .map((capture) => capture.value),
    [loadResult]
  );
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, [
    { value: loadResult, useCount: 2 }
  ]);
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
    /could not resolve JIT timeline value at expression op 0/
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
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
  const codegenPlan = planJitCodegen(buildBlock([cmp, cmove, trap]));
  const cmpExpressions = codegenPlan.analysis.instructions[0]!.expressions;
  const cmoveExpressions = codegenPlan.analysis.instructions[1]!.expressions;
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
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

  strictEqual(cmpExpressions.some((op) => op.op === "flags.set"), true);
  strictEqual(cmoveExpressions.some((op) =>
    op.op === "let32" && op.value.kind === "flags.condition"
  ), true);
  deepStrictEqual(plannedRegisterStores(exit), [registerStore("edx", selectedEdx)]);
});

test("planJitCodegen keeps load-result values out of observed boundaries before their definitions", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "loadResult-before-exit-observation",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x10000 },
          byteLength: 4,
          access: "read"
        },
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: { kind: "const", type: "i32", value: 0x10000 } },
          accessWidth: 32
        },
        {
          op: "set",
          target: { kind: "reg", reg: "eax" },
          value: { kind: "var", id: 0 },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const readFault = onlyExit(codegenPlan.exits, ExitReason.MEMORY_READ_FAULT);
  const hostTrap = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const expressionBlock = codegenPlan.analysis.instructions[0]!.expressions;
  const guardOpIndex = expressionOpIndex(expressionBlock, "memory.guard");
  const hostTrapOpIndex = expressionOpIndex(expressionBlock, "hostTrap");
  const loadResult = jitLoadResultValue(0, "i32");

  strictEqual(readFault.at.opIndex, guardOpIndex);
  strictEqual(readFault.exitStoreIndex, 0);
  deepStrictEqual(readFault.stores, []);
  strictEqual(hostTrap.at.opIndex, hostTrapOpIndex);
  deepStrictEqual(plannedRegisterStores(hostTrap), [
    registerStore("eax", loadResult)
  ]);
});

function expressionOpIndex<T extends IrExprBlock[number]["op"]>(
  block: IrExprBlock,
  opName: T,
  matches: (op: Extract<IrExprBlock[number], { op: T }>) => boolean = () => true
): number {
  const index = block.findIndex((op) =>
    op.op === opName && matches(op as Extract<IrExprBlock[number], { op: T }>)
  );

  if (index < 0) {
    throw new Error(`missing expression op ${opName}`);
  }

  return index;
}
