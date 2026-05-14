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
  exitPoint,
  exitState,
  c32,
  addValue,
  type JitCodegenPlan,
  type JitExitMaterializationStore,
  type JitValue,
  type JitIrBlock,
} from "./plan-test-helpers.js";
import type { JitPlannedValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";
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
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x1000 },
          byteLength: 4,
          access: "read"
        },
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
  const produced = jitProducedValue("load#partial-effectful-flag-input:0:1:0", "i32");
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

  deepStrictEqual(exit.observedState.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(codegenPlan.exitMaterializations[exit.exitMaterializationIndex], {
    stores: [expectedFlagStore]
  });
  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(expectedFlagStore, exit, exitPointIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
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

test("planJitCodegen records register and flag exit stores as exit-store value uses", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const load = ok(decodeBytes([0x8b, 0x05, 0x00, 0x00, 0x01, 0x00], add.nextEip));
  const codegenPlan = planJitCodegen(optimizeJitIrBlock(buildJitIrBlock([add, load])));
  const exit = onlyExit(codegenPlan.exitPoints, ExitReason.MEMORY_READ_FAULT);
  const exitPointIndex = codegenPlan.exitPoints.indexOf(exit);
  const expectedRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const expectedFlagStore = flagStore(exit.observedState.valueState.flags.readAluFlags());
  const needs = codegenPlan.materializationNeeds.filter((need) =>
    need.placement.exitPointIndex === exitPointIndex
  );

  deepStrictEqual(needs, [
    exitStoreNeed(expectedRegisterStore, exit, exitPointIndex),
    exitStoreNeed(expectedFlagStore, exit, exitPointIndex)
  ]);
  deepStrictEqual(needs.map((need) => need.purpose), ["exitStore", "exitStore"]);
  deepStrictEqual(needs.map((need) => Object.keys(need).sort()), [
    ["pathScope", "placement", "purpose", "target", "value"],
    ["pathScope", "placement", "purpose", "target", "value"]
  ]);
  strictEqual(needs.some((need) => "consumer" in need), false);

  for (const need of needs) {
    strictEqual(need.placement.instructionIndex, exit.instructionIndex);
    strictEqual(need.placement.opIndex, exit.opIndex);
    strictEqual(need.placement.exitReason, exit.exitReason);
    strictEqual(need.placement.exitMaterializationIndex, exit.exitMaterializationIndex);
  }
});

test("buildJitCodegenEmissionPlan accounts repeated register and flag store dependencies through exit-store uses", () => {
  const commonValue = addValue(jitInputReg32Value("eax"), c32(1));
  const emissionPlan = buildHostTrapEmissionPlanForStores("generic-store-use-counts", [
    registerStore("ebx", commonValue),
    flagStore(commonValue)
  ]);
  const [instruction] = emissionPlan.instructions;

  if (instruction === undefined) {
    throw new Error("missing emission instruction");
  }

  const hostTrapIndex = instruction.expressionBlock.findIndex((op) => op.op === "hostTrap");

  strictEqual(hostTrapIndex !== -1, true);
  deepStrictEqual(
    plannedRootValues(emissionPlan.plannedValueUses, 0, hostTrapIndex, "exitStore"),
    [commonValue, commonValue]
  );
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
    { value: commonValue, useCount: 2 }
  ]);
});

test("buildJitCodegenEmissionPlan counts flag-producer inputs through the same materialization graph", () => {
  const commonValue = addValue(jitInputReg32Value("eax"), c32(1));
  const result = addValue(commonValue, c32(1));
  const flags = jitFlagProducerValue("inc", {
    left: commonValue,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const emissionPlan = buildHostTrapEmissionPlanForStores("generic-flag-producer-use-counts", [
    registerStore("ebx", commonValue),
    flagStore(flags)
  ]);

  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
    { value: commonValue, useCount: 3 }
  ]);
});

function buildHostTrapEmissionPlanForStores(
  instructionId: string,
  stores: readonly JitExitMaterializationStore[]
) {
  const block: JitIrBlock = {
    instructions: [{
      instructionId,
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "hostTrap", vector: { kind: "const", type: "i32", value: 0x2e } }
      ]
    }]
  };
  const initialState = exitState(0);
  const postSnapshot = exitState(1);
  const exit = exitPoint({
    instructionIndex: 0,
    opIndex: 0,
    exitReason: ExitReason.HOST_TRAP,
    observedState: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    exitMaterializationIndex: 1
  });
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId,
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: initialState.instructionCountDelta,
      initialValueState: initialState.valueState,
      controlPathScopes: new Map(),
      exitPointCount: 1
    }],
    exitPoints: [exit],
    materializationNeeds: stores.map((store) => exitStoreNeed(store, exit, 0)),
    exitMaterializations: [
      { stores: [] },
      { stores }
    ],
    maxExitMaterializationIndex: 1
  };

  return buildJitCodegenEmissionPlan(plan);
}

test("planJitCodegen feeds produced exit-store values into materialization needs", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "produced-exit-store",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "memory.guard",
          address: { kind: "const", type: "i32", value: 0x1000 },
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
  const produced = jitProducedValue("load#produced-exit-store:0:1:0", "i32");
  const exitValue = addValue(produced, jitInputReg32Value("ebx"));

  deepStrictEqual(codegenPlan.materializationNeeds, [
    exitStoreNeed(registerStore("eax", exitValue), exit, exitPointIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
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
    codegenPlan.materializationNeeds.filter((need) =>
      need.purpose === "exitStore" &&
      need.target.kind === "reg32"
    ),
    [
      exitStoreNeed(registerStore("eax", c32(0)), exit, 0),
      exitStoreNeed(registerStore("ebx", clobberedInputValue), exit, 0)
    ]
  );
});

test("buildJitCodegenEmissionPlan maps exit-store uses at source exit locations", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "flag-exit-before-register-write",
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
  const entrySnapshot = exitState(0);
  const postSnapshot = exitState(1, ["eax"]);
  const readFaultExit = exitPoint({
    instructionIndex: 0,
    opIndex: 0,
    exitReason: ExitReason.MEMORY_READ_FAULT,
    observedState: entrySnapshot,
    visibleEip: { kind: "static", value: startAddress },
    payload: { kind: "runtime", source: "memoryAddress" },
    exitMaterializationIndex: 1
  });
  const hostTrapExit = exitPoint({
    instructionIndex: 0,
    opIndex: 5,
    exitReason: ExitReason.HOST_TRAP,
    observedState: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    exitMaterializationIndex: 2
  });
  const produced = jitProducedValue("load#flag-exit-before-register-write:0:1:0", "i32");
  const hostTrapRegisterStore = registerStore("eax", produced);
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "flag-exit-before-register-write",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: entrySnapshot.instructionCountDelta,
      initialValueState: entrySnapshot.valueState,
      controlPathScopes: new Map(),
      exitPointCount: 2
    }],
    exitPoints: [
      readFaultExit,
      hostTrapExit
    ],
    materializationNeeds: [
      exitStoreNeed(hostTrapRegisterStore, hostTrapExit, 1)
    ],
    exitMaterializations: [
      { stores: [] },
      { stores: [flagStore(c32(IR_ALU_FLAG_MASK))] },
      { stores: [hostTrapRegisterStore] }
    ],
    maxExitMaterializationIndex: 2
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);
  const [instruction] = emissionPlan.instructions;

  if (instruction === undefined) {
    throw new Error("missing emission instruction");
  }

  const expressionBlock = instruction.expressionBlock;
  const hostTrapIndex = expressionBlock.findIndex((op) => op.op === "hostTrap");

  strictEqual(hostTrapIndex !== -1, true);
  deepStrictEqual(
    plannedRootValues(emissionPlan.plannedValueUses, 0, hostTrapIndex, "exitStore"),
    [produced]
  );
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
});

test("buildJitCodegenEmissionPlan walks condition and select dependencies from exit-store uses", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "generic-select-dependencies",
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
  const produced = jitProducedValue("load#generic-select-dependencies:0:0:0", "i32");
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
  const entrySnapshot = exitState(0);
  const postSnapshot = exitState(1);
  const hostTrapExit = exitPoint({
    instructionIndex: 0,
    opIndex: 1,
    exitReason: ExitReason.HOST_TRAP,
    observedState: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    exitMaterializationIndex: 1
  });
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "generic-select-dependencies",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: entrySnapshot.instructionCountDelta,
      initialValueState: entrySnapshot.valueState,
      controlPathScopes: new Map(),
      exitPointCount: 1
    }],
    exitPoints: [hostTrapExit],
    materializationNeeds: [
      exitStoreNeed(flagStore(selectedFlags), hostTrapExit, 0)
    ],
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
    plannedRootValues(emissionPlan.plannedValueUses, 0, hostTrapIndex, "exitStore"),
    [selectedFlags]
  );
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
    { value: produced, useCount: 1 }
  ]);
});

function plannedRootValues(
  uses: readonly JitPlannedValueUse[],
  instructionIndex: number,
  opIndex: number,
  purpose: string
): readonly JitValue[] {
  return uses
    .filter((use) =>
      use.placement.instructionIndex === instructionIndex &&
        use.placement.opIndex === opIndex &&
        use.purpose === purpose
    )
    .map((use) => use.value);
}
