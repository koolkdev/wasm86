import {
  deepStrictEqual,
  strictEqual,
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
  jitProducedValue,
  onlyExit,
  startAddress,
  registerStore,
  flagStore,
  exitStoreUse,
  exitPoint,
  exitState,
  c32,
  addValue,
  type JitCodegenPlan,
  type ExitStore,
  type JitValue,
  type JitBlock,
} from "./plan-test-helpers.js";
import type { JitPlannedValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";
test("planJitCodegen feeds partial flag exit-store inputs through exit store uses", () => {
  const block: JitBlock = {
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const exitIndex = codegenPlan.exits.indexOf(exit);
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

  deepStrictEqual(exit.snapshot.valueState.flags.readAluFlags(), expectedFlags);
  deepStrictEqual(codegenPlan.exitStoreSets[exit.exitStoreIndex], {
    stores: [expectedFlagStore]
  });
  deepStrictEqual(codegenPlan.exitStoreUses, [
    exitStoreUse(expectedFlagStore, exit, exitIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
    { value: produced, useCount: 2 }
  ]);
});

test("planJitCodegen omits exit store uses for empty exits", () => {
  const trap = ok(decodeBytes([0xcd, 0x2e], startAddress));
  const codegenPlan = planJitCodegen(buildBlock([trap]));
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);

  strictEqual(exit.exitStoreIndex, 0);
  deepStrictEqual(codegenPlan.exitStoreSets, [{ stores: [] }]);
  deepStrictEqual(codegenPlan.exitStoreUses, []);
});

test("planJitCodegen records register and flag exit stores as exit-store value uses", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const load = ok(decodeBytes([0x8b, 0x05, 0x00, 0x00, 0x01, 0x00], add.nextEip));
  const codegenPlan = planJitCodegen(buildBlock([add, load]));
  const exit = onlyExit(codegenPlan.exits, ExitReason.MEMORY_READ_FAULT);
  const exitIndex = codegenPlan.exits.indexOf(exit);
  const expectedRegisterStore = registerStore("eax", addValue(jitInputReg32Value("eax"), c32(1)));
  const expectedFlagStore = flagStore(exit.snapshot.valueState.flags.readAluFlags());
  const uses = codegenPlan.exitStoreUses.filter((use) =>
    use.placement.exitIndex === exitIndex
  );

  deepStrictEqual(uses, [
    exitStoreUse(expectedRegisterStore, exit, exitIndex),
    exitStoreUse(expectedFlagStore, exit, exitIndex)
  ]);
  deepStrictEqual(uses.map((use) => use.purpose), ["exitStore", "exitStore"]);
  deepStrictEqual(uses.map((use) => Object.keys(use).sort()), [
    ["path", "placement", "purpose", "target", "value"],
    ["path", "placement", "purpose", "target", "value"]
  ]);
  strictEqual(uses.some((use) => "consumer" in use), false);

  for (const use of uses) {
    strictEqual(use.placement.instructionIndex, exit.at.instructionIndex);
    strictEqual(use.placement.opIndex, exit.at.opIndex);
    strictEqual(use.placement.reason, exit.reason);
    strictEqual(use.placement.exitStoreIndex, exit.exitStoreIndex);
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

test("buildJitCodegenEmissionPlan counts flag-producer inputs through the same exit store graph", () => {
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
  stores: readonly ExitStore[]
) {
  const block: JitBlock = {
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
    reason: ExitReason.HOST_TRAP,
    snapshot: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    stores,
    exitStoreIndex: 1
  });
  const plan: JitCodegenPlan = {
    block,
    effects: [{
      kind: "hostTrap",
      at: { instructionIndex: 0, opIndex: 0 },
      exit
    }],
    instructionStates: [{
      instructionId,
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: initialState.instructionCountDelta,
      initialValueState: initialState.valueState,
      paths: new Map(),
      exitCount: 1
    }],
    exits: [exit],
    exitStoreUses: stores.map((store) => exitStoreUse(store, exit, 0)),
    exitStoreSets: [
      { stores: [] },
      { stores }
    ],
    maxExitStoreIndex: 1
  };

  return buildJitCodegenEmissionPlan(plan);
}

test("planJitCodegen feeds produced exit-store values into exit store uses", () => {
  const block: JitBlock = {
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const exitIndex = codegenPlan.exits.indexOf(exit);
  const produced = jitProducedValue("load#produced-exit-store:0:1:0", "i32");
  const exitValue = addValue(produced, jitInputReg32Value("ebx"));

  deepStrictEqual(codegenPlan.exitStoreUses, [
    exitStoreUse(registerStore("eax", exitValue), exit, exitIndex)
  ]);
  deepStrictEqual(emissionPlan.valueCachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(emissionPlan.valueCachePlan?.useCounts, [
    { value: produced, useCount: 1 }
  ]);
});

test("planJitCodegen keeps clobber-sensitive exit-store values symbolic in exit store uses", () => {
  const block: JitBlock = {
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
  const exit = onlyExit(codegenPlan.exits, ExitReason.HOST_TRAP);
  const clobberedInputValue = addValue(jitInputReg32Value("eax"), c32(1));

  deepStrictEqual(codegenPlan.exitStoreSets[exit.exitStoreIndex]?.stores, [
    registerStore("eax", c32(0)),
    registerStore("ebx", clobberedInputValue)
  ]);
  deepStrictEqual(
    codegenPlan.exitStoreUses.filter((use) =>
      use.purpose === "exitStore" &&
      use.target.kind === "reg32"
    ),
    [
      exitStoreUse(registerStore("eax", c32(0)), exit, 0),
      exitStoreUse(registerStore("ebx", clobberedInputValue), exit, 0)
    ]
  );
});

test("buildJitCodegenEmissionPlan maps exit-store uses at source exit locations", () => {
  const block: JitBlock = {
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
  const readFaultStore = flagStore(c32(IR_ALU_FLAG_MASK));
  const readFaultExit = exitPoint({
    instructionIndex: 0,
    opIndex: 0,
    reason: ExitReason.MEMORY_READ_FAULT,
    snapshot: entrySnapshot,
    visibleEip: { kind: "static", value: startAddress },
    payload: { kind: "runtime", source: "memoryAddress" },
    stores: [readFaultStore],
    exitStoreIndex: 1
  });
  const produced = jitProducedValue("load#flag-exit-before-register-write:0:1:0", "i32");
  const hostTrapRegisterStore = registerStore("eax", produced);
  const hostTrapExit = exitPoint({
    instructionIndex: 0,
    opIndex: 5,
    reason: ExitReason.HOST_TRAP,
    snapshot: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    stores: [hostTrapRegisterStore],
    exitStoreIndex: 2
  });
  const plan: JitCodegenPlan = {
    block,
    effects: [
      {
        kind: "memoryGuard",
        at: { instructionIndex: 0, opIndex: 0 },
        faultExit: readFaultExit
      },
      {
        kind: "hostTrap",
        at: { instructionIndex: 0, opIndex: 5 },
        exit: hostTrapExit
      }
    ],
    instructionStates: [{
      instructionId: "flag-exit-before-register-write",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: entrySnapshot.instructionCountDelta,
      initialValueState: entrySnapshot.valueState,
      paths: new Map(),
      exitCount: 2
    }],
    exits: [
      readFaultExit,
      hostTrapExit
    ],
    exitStoreUses: [
      exitStoreUse(readFaultStore, readFaultExit, 0),
      exitStoreUse(hostTrapRegisterStore, hostTrapExit, 1)
    ],
    exitStoreSets: [
      { stores: [] },
      { stores: [readFaultStore] },
      { stores: [hostTrapRegisterStore] }
    ],
    maxExitStoreIndex: 2
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
  const block: JitBlock = {
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
    reason: ExitReason.HOST_TRAP,
    snapshot: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    stores: [flagStore(selectedFlags)],
    exitStoreIndex: 1
  });
  const plan: JitCodegenPlan = {
    block,
    effects: [{
      kind: "hostTrap",
      at: { instructionIndex: 0, opIndex: 1 },
      exit: hostTrapExit
    }],
    instructionStates: [{
      instructionId: "generic-select-dependencies",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      instructionCountDelta: entrySnapshot.instructionCountDelta,
      initialValueState: entrySnapshot.valueState,
      paths: new Map(),
      exitCount: 1
    }],
    exits: [hostTrapExit],
    exitStoreUses: [
      exitStoreUse(flagStore(selectedFlags), hostTrapExit, 0)
    ],
    exitStoreSets: [
      { stores: [] },
      { stores: [flagStore(selectedFlags)] }
    ],
    maxExitStoreIndex: 1
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
