import {
  deepStrictEqual,
  strictEqual,
  test,
  ok,
  decodeBytes,
  IR_ALU_FLAG_MASK,
  FLAG_PRODUCERS,
  ExitReason,
  buildJitIrBlock,
  buildJitCodegenEmissionPlan,
  planJitMaterializationUses,
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
  instructionEntryPoint,
  snapshot,
  c32,
  addValue,
  type JitCodegenPlan,
  type JitValue,
  type JitIrBlock,
} from "./plan-test-helpers.js";
test("planJitCodegen feeds partial flag exit-store inputs through materialization needs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "partial-effectful-flag-input",
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
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const codegenPlan = planJitCodegen(block);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);
  const exitPointIndex = codegenPlan.exitPoints.indexOf(exit);
  const produced = jitProducedValue("load#partial-effectful-flag-input:0:0:0", "i32");
  const result = addValue(produced, c32(1));
  const incFlags = jitFlagProducerValue("inc", {
    left: produced,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const expectedFlags = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    FLAG_PRODUCERS.inc.writtenMask
  );
  const expectedFlagStore = flagStore(expectedFlags);

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), expectedFlags);
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

test("planJitCodegen omits materialization needs for empty exits", () => {
  const trap = ok(decodeBytes([0xcd, 0x2e], startAddress));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([trap])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.HOST_TRAP);

  strictEqual(exit.exitMaterializationIndex, 0);
  deepStrictEqual(codegenPlan.exitMaterializations, [{ stores: [] }]);
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
  deepStrictEqual(emissionPlan.valueCachePlan?.captureValuesByEpoch[0], [produced]);
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

test("buildJitCodegenEmissionPlan maps exit-store uses at source exit locations past flag-store exits", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "flag-exit-before-register-write",
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
      instructionId: "flag-exit-before-register-write",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      entryPoint: instructionEntryPoint(0, snapshot("preInstruction", startAddress, 0), {
        preInstructionExitPlan: {
          exitPointCount: 1
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
        snapshot: snapshot("preInstruction", startAddress, 0),
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
    materializationNeeds: [{
      consumer: "registerExitStore",
      target: { kind: "reg32", reg: "eax" },
      value: addValue(jitInputReg32Value("eax"), c32(1)),
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
      { stores: [] },
      { stores: [flagStore(c32(IR_ALU_FLAG_MASK))] },
      { stores: [registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)))] }
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
  deepStrictEqual(uses?.get(hostTrapIndex), [addValue(jitInputReg32Value("eax"), c32(1))]);
});

test("buildJitCodegenEmissionPlan walks flag-store condition and select dependencies", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "flag-store-select-dependencies",
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
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const produced = jitProducedValue("load#flag-store-select-dependencies:0:0:0", "i32");
  const conditionFlags = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    produced,
    FLAG_PRODUCERS.inc.writtenMask
  );
  const selectedFlags = {
    kind: "value.select",
    type: "i32",
    condition: jitFlagConditionValue(conditionFlags, "E"),
    whenTrue: c32(0x10),
    whenFalse: c32(0x20)
  } as const satisfies JitValue;
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "flag-store-select-dependencies",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      entryPoint: instructionEntryPoint(0, snapshot("preInstruction", startAddress, 0)),
      postInstructionState: snapshot("postInstruction", startAddress + 1, 1),
      exitPointCount: 1
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 1,
      exitReason: ExitReason.HOST_TRAP,
      snapshot: snapshot("postInstruction", startAddress + 1, 1),
      exitMaterializationIndex: 1
    }],
    materializationNeeds: [{
      consumer: "flagExitStore",
      target: { kind: "aluFlags" },
      value: selectedFlags,
      placement: {
        instructionIndex: 0,
        opIndex: 1,
        exitPointIndex: 0,
        exitReason: ExitReason.HOST_TRAP,
        exitMaterializationIndex: 1
      },
      pathScope: "deferredExit"
    }],
    exitMaterializations: [
      { stores: [] },
      { stores: [flagStore(selectedFlags)] }
    ],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);
  const [instruction] = emissionPlan.instructions;

  if (instruction === undefined) {
    throw new Error("missing emission instruction");
  }

  const hostTrapIndex = instruction.expressionBlock.findIndex((op) => op.op === "hostTrap");

  strictEqual(hostTrapIndex !== -1, true);
  deepStrictEqual(
    instruction.valueCachePlan?.instructionPlans[0]?.materializationJitValueUsesByExpressionIndex?.get(hostTrapIndex),
    [selectedFlags]
  );
  deepStrictEqual(emissionPlan.valueCachePlan?.captureValuesByEpoch[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.selectedUseCounts, [
    { value: produced, useCount: 1 }
  ]);
});
