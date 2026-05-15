import {
  deepStrictEqual,
  strictEqual,
  test,
  ExitReason,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  jitExtractBits,
  jitInputReg32Value,
  jitProducedValue,
  startAddress,
  planValueCacheForTest,
  materializationUse,
  registerStore,
  exitPoint,
  exitState,
  c32,
  addValue,
  type JitCodegenPlan,
  type JitValue,
  type JitBlock,
} from "./plan-test-helpers.js";
test("buildJitCodegenEmissionPlan prepares expression blocks and value-cache specs", () => {
  const block: JitBlock = {
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
  strictEqual(instruction?.valueTimeline.expressionValuesByExpressionOpIndex.length, instruction?.expressionBlock.length);
  strictEqual((emissionPlan.valueCachePlan?.useCounts.length ?? 0) > 0, true);
  strictEqual((emissionPlan.valueCachePlan?.consumers.length ?? 0) > 0, true);
});

test("buildJitCodegenEmissionPlan does not count overwritten planned register writes as exit-store uses", () => {
  const block: JitBlock = {
    instructions: [
      {
        instructionId: "write-before-overwrite",
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
        instructionId: "write-before-overwrite",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        instructionCountDelta: 0,
        initialValueState: exitState(0).valueState,
        controlPathScopes: new Map(),
        exitPointCount: 0
      },
      {
        instructionId: "overwrite-before-exit",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "exit",
        instructionCountDelta: 1,
        initialValueState: exitState(1, ["eax"]).valueState,
        controlPathScopes: new Map(),
        exitPointCount: 1
      }
    ],
    exitPoints: [exitPoint({
      instructionIndex: 1,
      opIndex: 1,
      exitReason: ExitReason.HOST_TRAP,
      observedState: exitState(2, ["eax"]),
      exitMaterializationIndex: 1
    })],
    materializationNeeds: [],
    exitMaterializations: [{ stores: [] }, { stores: [registerStore("eax")] }],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);

  deepStrictEqual(emissionPlan.valueCachePlan.useCounts, []);
});

test("buildJitCodegenEmissionPlan does not count same-instruction later register writes for earlier exits", () => {
  const block: JitBlock = {
    instructions: [{
      instructionId: "fault-before-register-write",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
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
        { op: "next" }
      ]
    }]
  };
  const plan: JitCodegenPlan = {
    block,
    instructionStates: [{
      instructionId: "fault-before-register-write",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
      instructionCountDelta: 0,
      initialValueState: exitState(0, ["eax"]).valueState,
      controlPathScopes: new Map(),
      exitPointCount: 1
    }],
    exitPoints: [exitPoint({
      instructionIndex: 0,
      opIndex: 0,
      exitReason: ExitReason.MEMORY_READ_FAULT,
      observedState: exitState(0, ["eax"]),
      visibleEip: { kind: "static", value: startAddress },
      payload: { kind: "runtime", source: "memoryAddress" },
      exitMaterializationIndex: 1
    })],
    materializationNeeds: [],
    exitMaterializations: [{ stores: [] }, { stores: [registerStore("eax")] }],
    maxExitMaterializationIndex: 1
  };
  const emissionPlan = buildJitCodegenEmissionPlan(plan);

  deepStrictEqual(emissionPlan.valueCachePlan.useCounts, []);
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
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    }
  ] as const;
  const cachePlan = planValueCacheForTest({
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]]),
    materializationUses: new Map([[2, [materializationUse(produced)]]])
  });

  deepStrictEqual(cachePlan?.instructions[0]?.valueTimeline.valueRefValuesByExpressionOpIndex[0]?.get(0), produced);
  deepStrictEqual(cachePlan?.instructions[0]?.valueTimeline.expressionValuesByExpressionOpIndex[0]?.get(expressionBlock[0].value), produced);
  deepStrictEqual(cachePlan?.definitionCaptures[0], [produced]);
  deepStrictEqual(cachePlan?.consumers[0], []);
  deepStrictEqual(cachePlan?.consumers[1], [{ value: produced, useCount: 1 }]);
  deepStrictEqual(cachePlan?.useCounts, [{ value: produced, useCount: 1 }]);
});

test("JIT value-cache planning resolves input partial-register reads with common value rules", () => {
  const inputAl = {
    kind: "source",
    source: { kind: "reg", reg: "eax" },
    accessWidth: 8
  } as const;
  const expression = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: inputAl,
    b: { kind: "const", type: "i32", value: 0x12 }
  } as const;
  const expressionBlock = [{
    op: "conditionalJump",
    condition: { kind: "const", type: "i32", value: 1 },
    taken: expression,
    notTaken: expression
  }] as const;
  const cachePlan = planValueCacheForTest({
    expressionBlock
  });
  const expectedSource = jitExtractBits(jitInputReg32Value("eax"), 0, 8);
  const expectedExpression = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: expectedSource,
    b: c32(0x12)
  } as const;

  deepStrictEqual(cachePlan?.instructions[0]?.valueTimeline.expressionValuesByExpressionOpIndex[0]?.get(inputAl), expectedSource);
  deepStrictEqual(cachePlan?.useCounts, [{ value: expectedExpression, useCount: 2 }]);
});

test("JIT value-cache planning handles current non-store consumers as normal expression uses", () => {
  const target = {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: {
      kind: "source",
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    b: { kind: "const", type: "i32", value: 1 }
  } as const;
  const expressionBlock = [
    { op: "jump", target },
    {
      op: "conditionalJump",
      condition: target,
      taken: target,
      notTaken: target
    },
    { op: "hostTrap", vector: target }
  ] as const;
  const expected = addValue(jitInputReg32Value("eax"), c32(1));
  const cachePlan = planValueCacheForTest({
    expressionBlock
  });

  deepStrictEqual(cachePlan?.useCounts, [{ value: expected, useCount: 5 }]);
});

test("JIT value-cache planning counts memory guard addresses as normal expression uses", () => {
  const address = {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: {
      kind: "source",
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    b: { kind: "const", type: "i32", value: 1 }
  } as const;
  const expressionBlock = [
    { op: "memory.guard", address, byteLength: 4, access: "read" },
    { op: "memory.guard", address, byteLength: 4, access: "write" }
  ] as const;
  const cachePlan = planValueCacheForTest({ expressionBlock });

  deepStrictEqual(cachePlan?.useCounts, [
    { value: addValue(jitInputReg32Value("eax"), c32(1)), useCount: 2 }
  ]);
});

test("JIT value-cache planning keeps repeated post-write expression uses point-specific", () => {
  const expression = {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: {
      kind: "source",
      source: { kind: "reg", reg: "eax" },
      accessWidth: 32
    },
    b: { kind: "const", type: "i32", value: 1 }
  } as const;
  const expressionBlock = [
    { op: "hostTrap", vector: expression },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: { kind: "const", type: "i32", value: 5 }, accessWidth: 32 },
    { op: "hostTrap", vector: expression },
    { op: "hostTrap", vector: expression }
  ] as const;
  const cachePlan = planValueCacheForTest({ expressionBlock });
  const instructionPlan = cachePlan?.instructions[0];
  const preWriteValue = addValue(jitInputReg32Value("eax"), c32(1));
  const postWriteValue = addValue(c32(5), c32(1));

  deepStrictEqual(
    instructionPlan?.valueTimeline.expressionValuesByExpressionOpIndex[0]?.get(expression),
    preWriteValue
  );
  deepStrictEqual(
    instructionPlan?.valueTimeline.expressionValuesByExpressionOpIndex[2]?.get(expression),
    postWriteValue
  );
  deepStrictEqual(instructionPlan?.opEpochs, [0, 0, 1, 1]);
  deepStrictEqual(cachePlan?.consumers[0], []);
  deepStrictEqual(cachePlan?.consumers[1], [{ value: postWriteValue, useCount: 2 }]);
  deepStrictEqual(cachePlan?.useCounts, [{ value: postWriteValue, useCount: 2 }]);
});

test("JIT value-cache planning prices emitted var reads as resolved JitValue graph uses", () => {
  const expressionBlock = [
    {
      op: "let32",
      dst: { kind: "var", id: 0 },
      value: {
        kind: "value.binary",
        type: "i32",
        operator: "xor",
        a: {
          kind: "value.binary",
          type: "i32",
          operator: "add",
          a: {
            kind: "source",
            source: { kind: "reg", reg: "eax" },
            accessWidth: 32
          },
          b: { kind: "const", type: "i32", value: 1 }
        },
        b: { kind: "const", type: "i32", value: 0xff }
      }
    },
    { op: "hostTrap", vector: { kind: "var", id: 0 } },
    { op: "hostTrap", vector: { kind: "var", id: 0 } }
  ] as const;
  const expected = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addValue(jitInputReg32Value("eax"), c32(1)),
    b: c32(0xff)
  } as const satisfies JitValue;
  const cachePlan = planValueCacheForTest({ expressionBlock });

  deepStrictEqual(cachePlan?.consumers[0], [{ value: expected, useCount: 2 }]);
  deepStrictEqual(cachePlan?.useCounts, [{ value: expected, useCount: 2 }]);
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
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    },
    {
      op: "set",
      target: { kind: "reg", reg: "edx" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    }
  ] as const;
  const cachePlan = planValueCacheForTest({
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]]),
    materializationUses: new Map([
      [1, [materializationUse(produced)]],
      [2, [materializationUse(produced)]]
    ])
  });

  deepStrictEqual(cachePlan?.useCounts, [{ value: produced, useCount: 2 }]);
});

test("JIT value-cache planning does not treat logical register writes as produced consumers", () => {
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
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: { kind: "var", id: 0 }, accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ecx" }, value: { kind: "var", id: 0 }, accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "edx" }, value: { kind: "var", id: 0 }, accessWidth: 32 }
  ] as const;
  const cachePlan = planValueCacheForTest({
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]])
  });

  deepStrictEqual(cachePlan.useCounts, []);
});

test("JIT value-cache planning skips produced values with no emitted or exit-store consumer", () => {
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
      op: "hostTrap",
      vector: { kind: "const", type: "i32", value: 0x2e }
    }
  ] as const;
  const cachePlan = planValueCacheForTest({
    expressionBlock,
    producedValuesByVarId: new Map([[0, produced]])
  });

  deepStrictEqual(cachePlan.useCounts, []);
});
