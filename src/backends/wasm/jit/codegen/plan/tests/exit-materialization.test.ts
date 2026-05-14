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
  buildJitIrBlock,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitProducedValue,
  optimizeJitIrBlock,
  onlyExit,
  startAddress,
  registerStore,
  flagStore,
  exitStoreNeed,
  c32,
  addValue,
  subValue,
  beforeOp,
  afterOp,
  instructionEntry,
  instructionExit,
  type JitValue,
  type JitIrBlock,
} from "./plan-test-helpers.js";
test("JIT boundary helpers produce explicit instruction timeline coordinates", () => {
  const instruction = { ir: [{ op: "first" }, { op: "second" }, { op: "third" }] };

  deepStrictEqual(instructionEntry(4), { instructionIndex: 4, boundaryIndex: 0 });
  deepStrictEqual(beforeOp(4, 2), { instructionIndex: 4, boundaryIndex: 2 });
  deepStrictEqual(afterOp(4, 2), { instructionIndex: 4, boundaryIndex: 3 });
  deepStrictEqual(instructionExit(4, instruction), { instructionIndex: 4, boundaryIndex: 3 });
});

test("planJitCodegen records post-instruction fallthrough exits", () => {
  const instruction = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([instruction])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.FALLTHROUGH);
  const instructionState = codegenPlan.instructionStates[0]!;

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { stores: [] },
    { stores: [registerStore("eax", c32(1))] }
  ]);
  strictEqual(instructionState.entryPoint.instructionIndex, 0);
  deepStrictEqual(instructionState.entryPoint.boundaryState.boundary, instructionEntry(0));
  strictEqual("kind" in instructionState.entryPoint.boundaryState, false);
  strictEqual("eip" in instructionState.entryPoint.boundaryState, false);
  strictEqual(instructionState.entryPoint.preInstructionExitPlan, undefined);
  strictEqual(instructionState.exitPointCount, 1);
  deepStrictEqual(exit.emitBoundary, beforeOp(0, exit.opIndex));
  deepStrictEqual(exit.observedBoundary, instructionExit(0, codegenPlan.block.instructions[0]!));
  strictEqual(codegenPlan.boundaryStates[0], exit.observedState);
  deepStrictEqual(exit.visibleEip, { kind: "static", value: instruction.nextEip });
  deepStrictEqual(exit.payload, { kind: "static", value: instruction.nextEip });
  strictEqual(exit.pathScope, "deferredExit");
  deepStrictEqual(exit.observedState.boundary, instructionExit(0, codegenPlan.block.instructions[0]!));
  strictEqual("kind" in exit.observedState, false);
  strictEqual("eip" in exit.observedState, false);
  strictEqual(exit.observedState.instructionCountDelta, 1);
  strictEqual(exit.exitMaterializationIndex, 1);
  deepStrictEqual(exit.observedState.valueState.regs.exitStores(), [registerStore("eax", c32(1))]);
  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(registerStore("eax", c32(1)), exit, 0)
  ]);
});

test("planJitCodegen keeps memory faults at pre-instruction boundary states", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const load = ok(decodeBytes([0x8b, 0x05, 0x00, 0x00, 0x01, 0x00], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, load])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_READ_FAULT);
  const loadInstructionState = codegenPlan.instructionStates[1]!;

  deepStrictEqual(codegenPlan.instructionStates.map((entry) =>
    entry.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0
  ), [0, 1]);
  strictEqual(loadInstructionState.entryPoint.instructionIndex, 1);
  deepStrictEqual(loadInstructionState.entryPoint.boundaryState.boundary, instructionEntry(1));
  deepStrictEqual(loadInstructionState.entryPoint.preInstructionExitPlan, {
    exitPointCount: 1
  });
  strictEqual(exit.instructionIndex, 1);
  deepStrictEqual(exit.emitBoundary, beforeOp(1, 0));
  deepStrictEqual(exit.observedBoundary, instructionEntry(1));
  deepStrictEqual(exit.visibleEip, { kind: "static", value: add.nextEip });
  deepStrictEqual(exit.payload, { kind: "runtime", source: "memoryAddress" });
  deepStrictEqual(exit.observedState.boundary, instructionEntry(1));
  strictEqual(exit.observedState.instructionCountDelta, 1);
  strictEqual(exit.exitMaterializationIndex, 1);
  const expectedRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const expectedFlagStore = flagStore(exit.observedState.valueState.flags.readAluFlags());

  deepStrictEqual(exit.observedState.valueState.regs.exitStores(), [expectedRegisterStore]);
  deepStrictEqual(exit.observedState.valueState.flags.exitStores(), [expectedFlagStore]);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [expectedRegisterStore, expectedFlagStore]
  });
  deepStrictEqual(codegenPlan.materializationNeeds.filter((need) => need.placement.exitPointIndex === 0), [
    exitStoreNeed(expectedRegisterStore, exit, 0),
    exitStoreNeed(expectedFlagStore, exit, 0)
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
  deepStrictEqual(writeFaults.map((exit) => exit.observedState.valueState.regs.exitStores()), [
    [registerStore("eax", c32(0x1111_1111))],
    [registerStore("eax", c32(0x2222_2222))]
  ]);
  strictEqual(writeFaults[0]!.exitMaterializationIndex !== writeFaults[1]!.exitMaterializationIndex, true);
  deepStrictEqual(writeFaults.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { stores: [registerStore("eax", c32(0x1111_1111))] },
    { stores: [registerStore("eax", c32(0x2222_2222))] }
  ]);
});

test("planJitCodegen derives xchg exit stores from value-state boundary states", () => {
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

  deepStrictEqual(exit.observedState.valueState.regs.exitStores(), [
    registerStore("ecx", jitInputReg32Value("edx")),
    registerStore("edx", jitInputReg32Value("ecx"))
  ]);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [
      registerStore("ecx", jitInputReg32Value("edx")),
      registerStore("edx", jitInputReg32Value("ecx"))
    ]
  });
});

test("planJitCodegen excludes current-instruction speculative writes from memory fault boundary states", () => {
  const instruction = ok(decodeBytes([0x01, 0x18], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([instruction])));
  const instructionState = codegenPlan.instructionStates[0]!;
  const writeFault = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_WRITE_FAULT);

  deepStrictEqual(instructionState.entryPoint.preInstructionExitPlan, {
    exitPointCount: 2
  });
  deepStrictEqual(writeFault.observedState.boundary, instructionEntry(0));
  strictEqual(writeFault.observedState.instructionCountDelta, 0);
  strictEqual(writeFault.exitMaterializationIndex, 0);
  deepStrictEqual(writeFault.observedState.valueState.regs.exitStores(), []);
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

  deepStrictEqual(readFault.observedState.boundary, instructionEntry(0));
  deepStrictEqual(readFault.emitBoundary, beforeOp(0, 2));
  deepStrictEqual(readFault.observedBoundary, instructionEntry(0));
  deepStrictEqual(readFault.visibleEip, { kind: "static", value: startAddress });
  deepStrictEqual(readFault.payload, { kind: "runtime", source: "memoryAddress" });
  strictEqual(readFault.exitMaterializationIndex, 0);
  deepStrictEqual(readFault.observedState.valueState.regs.exitStores(), []);
  deepStrictEqual(hostTrap.observedState.boundary, instructionExit(0, codegenPlan.block.instructions[0]!));
  deepStrictEqual(hostTrap.emitBoundary, beforeOp(0, 3));
  deepStrictEqual(hostTrap.observedBoundary, instructionExit(0, codegenPlan.block.instructions[0]!));
  deepStrictEqual(hostTrap.visibleEip, { kind: "static", value: startAddress + 1 });
  deepStrictEqual(hostTrap.payload, { kind: "runtime", source: "hostTrapVector" });
  strictEqual(hostTrap.exitMaterializationIndex, 1);
  deepStrictEqual(hostTrap.observedState.valueState.regs.exitStores(), [registerStore("eax", c32(0x1234))]);
});

test("planJitCodegen keeps same-instruction flag writes out of later pre-instruction faults", () => {
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
          op: "get",
          dst: { kind: "var", id: 2 },
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
  const expectedFlags = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    jitFlagProducerValue("inc", {
      left: jitInputReg32Value("eax"),
      result: addValue(jitInputReg32Value("eax"), c32(1))
    }, { mask: FLAG_PRODUCERS.inc.writtenMask }),
    FLAG_PRODUCERS.inc.writtenMask
  );

  deepStrictEqual(readFault.observedState.boundary, instructionEntry(0));
  strictEqual(readFault.exitMaterializationIndex, 0);
  deepStrictEqual(readFault.observedState.valueState.flags.exitStores(), []);
  deepStrictEqual(hostTrap.observedState.boundary, instructionExit(0, codegenPlan.block.instructions[0]!));
  strictEqual(hostTrap.exitMaterializationIndex, 1);
  deepStrictEqual(hostTrap.observedState.valueState.flags.exitStores(), [flagStore(expectedFlags)]);
});

test("planJitCodegen records exit materializations only for actual exit points", () => {
  const movEax = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const movEbx = ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], movEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEbx.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([movEax, movEbx, trap])));

  strictEqual(codegenPlan.maxExitMaterializationIndex, 1);
  deepStrictEqual(codegenPlan.exitMaterializations, [
    { stores: [] },
    { stores: [registerStore("eax", c32(1)), registerStore("ebx", c32(2))] }
  ]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) =>
    entry.entryPoint.preInstructionExitPlan?.exitPointCount ?? 0
  ), [0, 0, 0]);
  deepStrictEqual(codegenPlan.instructionStates.map((entry) => entry.exitPointCount), [0, 0, 1]);
});

test("planJitCodegen records boundary-state-derived flag stores for branch exits", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jb = ok(decodeBytes([0x72, 0x05], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, jb])));
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const branchExits = codegenPlan.exitPoints.filter((entry) =>
    entry.exitReason === ExitReason.JUMP && (entry.pathScope === "taken" || entry.pathScope === "notTaken")
  );
  const branchIr = codegenPlan.block.instructions[1]!.ir;
  const branchExpressionBlock = emissionPlan.instructions[1]?.expressionBlock;
  const conditionalJumpIndex = branchExpressionBlock?.findIndex((op) => op.op === "conditionalJump") ?? -1;

  strictEqual(branchIr.some((op) => op.op === "flags.condition"), true);
  strictEqual(branchExits.length, 2);

  for (const exit of branchExits) {
    deepStrictEqual(exit.observedState.boundary, instructionExit(1, codegenPlan.block.instructions[1]!));
    deepStrictEqual(exit.emitBoundary, beforeOp(1, exit.opIndex));
    deepStrictEqual(exit.observedBoundary, instructionExit(1, codegenPlan.block.instructions[1]!));
    deepStrictEqual(exit.observedState.valueState.flags.exitStores(), [
      flagStore(exit.observedState.valueState.flags.readAluFlags())
    ]);
  }

  strictEqual(branchExits[0]!.observedState, branchExits[1]!.observedState);
  deepStrictEqual(
    codegenPlan.boundaryStates.map((state) => state.boundary),
    uniqueObservedBoundaries(codegenPlan.exitPoints)
  );
  strictEqual(codegenPlan.boundaryStates.length, 1);
  strictEqual(codegenPlan.boundaryStates[0], branchExits[0]!.observedState);
  deepStrictEqual(branchExits.map((exit) => exit.visibleEip), [
    { kind: "static", value: jb.nextEip + 5 },
    { kind: "static", value: jb.nextEip }
  ]);
  deepStrictEqual(branchExits.map((exit) => exit.payload), [
    { kind: "static", value: jb.nextEip + 5 },
    { kind: "static", value: jb.nextEip }
  ]);
  deepStrictEqual(branchExits.map((exit) => exit.pathScope), ["taken", "notTaken"]);

  strictEqual(conditionalJumpIndex > 0, true);
  strictEqual(branchExits[0]!.exitMaterializationIndex !== branchExits[1]!.exitMaterializationIndex, true);
  const branchRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const branchFlagStore = flagStore(branchExits[0]!.observedState.valueState.flags.readAluFlags());

  deepStrictEqual(branchExits.map((exit) => codegenPlan.exitMaterializations[exit.exitMaterializationIndex]), [
    { stores: [branchRegisterStore, branchFlagStore] },
    { stores: [branchRegisterStore, branchFlagStore] }
  ]);
  deepStrictEqual(
    codegenPlan.materializationNeeds
      .filter((need) =>
        need.purpose === "exitStore" &&
        need.target.kind === "aluFlags" &&
        need.placement.exitReason === ExitReason.JUMP &&
        (need.pathScope === "taken" || need.pathScope === "notTaken")
      )
      .map((need) => ({
        value: need.value,
        target: need.target,
        purpose: need.purpose,
        pathScope: need.pathScope,
        exitReason: need.placement.exitReason
      })),
    [
      {
        value: branchFlagStore.value,
        target: { kind: "aluFlags" },
        purpose: "exitStore",
        pathScope: "taken",
        exitReason: ExitReason.JUMP
      },
      {
        value: branchFlagStore.value,
        target: { kind: "aluFlags" },
        purpose: "exitStore",
        pathScope: "notTaken",
        exitReason: ExitReason.JUMP
      }
    ]
  );
});

test("planJitCodegen records full flag producers in value-state boundary states", () => {
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
  const expectedFlags = jitFlagProducerValue("add", {
    left: eax,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK });
  const expectedFlagStore = flagStore(expectedFlags);

  deepStrictEqual(exit.observedState.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(exit.observedState.valueState.flags.exitStores(), [expectedFlagStore]);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [
      registerStore("eax", result),
      expectedFlagStore
    ]
  });
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

  deepStrictEqual(exit.observedState.valueState.flags.readAluFlags(), jitInsertMaskedBits(
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
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const exitPointIndex = codegenPlan.exitPoints.indexOf(exit);
  const produced = jitProducedValue("load#effectful-flag-input:0:0:0", "i32");
  const ebx = jitInputReg32Value("ebx");
  const result = addValue(produced, ebx);
  const expectedFlags = jitFlagProducerValue("add", {
    left: produced,
    right: ebx,
    result
  }, { mask: IR_ALU_FLAG_MASK });
  const expectedFlagStore = flagStore(expectedFlags);

  deepStrictEqual(exit.observedState.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [expectedFlagStore]
  });
  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(expectedFlagStore, exit, exitPointIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.captureValuesByEpoch[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.selectedUseCounts, [
    { value: produced, useCount: 2 }
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

  deepStrictEqual(exit.observedState.valueState.flags.readAluFlags(), jitFlagProducerValue("add", {
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
  deepStrictEqual(exit.observedState.valueState.regs.exitStore("edx"), registerStore("edx", selectedEdx));
});

test("planJitCodegen keeps produced values out of observed boundaries before their definitions", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "produced-before-observed-boundary",
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
  const readFault = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_READ_FAULT);
  const hostTrap = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const produced = jitProducedValue("load#produced-before-observed-boundary:0:0:0", "i32");

  deepStrictEqual(readFault.observedBoundary, instructionEntry(0));
  strictEqual(readFault.exitMaterializationIndex, 0);
  deepStrictEqual(readFault.observedState.valueState.exitStores(), []);
  deepStrictEqual(
    codegenPlan.materializationNeeds.filter((need) =>
      need.placement.exitPointIndex === codegenPlan.exitPoints.indexOf(readFault)
    ),
    []
  );
  deepStrictEqual(hostTrap.observedBoundary, instructionExit(0, block.instructions[0]!));
  deepStrictEqual(hostTrap.observedState.valueState.regs.exitStores(), [
    registerStore("eax", produced)
  ]);
  deepStrictEqual(
    codegenPlan.boundaryStates.map((state) => state.boundary),
    uniqueObservedBoundaries(codegenPlan.exitPoints)
  );
});

function uniqueObservedBoundaries(exitPoints: readonly { observedBoundary: ReturnType<typeof instructionEntry> }[]) {
  const unique: ReturnType<typeof instructionEntry>[] = [];

  for (const exitPoint of exitPoints) {
    if (!unique.some((boundary) =>
      boundary.instructionIndex === exitPoint.observedBoundary.instructionIndex &&
        boundary.boundaryIndex === exitPoint.observedBoundary.boundaryIndex
    )) {
      unique.push(exitPoint.observedBoundary);
    }
  }

  return unique;
}
