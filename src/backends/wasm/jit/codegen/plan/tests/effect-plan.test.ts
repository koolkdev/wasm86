import {
  deepStrictEqual,
  strictEqual,
  test,
  buildJitCodegenEmissionPlan,
  c32,
  c32Expr,
  jitInputReg32Value,
  jitProducedValue,
  planJitCodegen,
  IR_ALU_FLAG_MASK,
  startAddress,
  type JitBlock
} from "./plan-test-helpers.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";

test("JIT effect plan leaves pure expressions and state updates out of cache roots", () => {
  const block: JitBlock = {
    instructions: [{
      instructionId: "state-updates-only",
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
          b: c32Expr(1)
        },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: { kind: "var", id: 1 }, accessWidth: 32 },
        {
          op: "flags.set",
          producer: "logic",
          writtenMask: IR_ALU_FLAG_MASK,
          undefMask: 0,
          inputs: { result: { kind: "var", id: 1 } }
        },
        { op: "next" }
      ]
    }]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));

  deepStrictEqual(emissionPlan.plannedEffects, []);
  deepStrictEqual(emissionPlan.valueUses, []);
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, []);
});

test("JIT effect plan attaches roots for ordered effects and exit stores", () => {
  const block: JitBlock = {
    instructions: [
      {
        instructionId: "guard-root",
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
            b: c32Expr(1)
          },
          { op: "memory.guard", address: { kind: "var", id: 1 }, byteLength: 4, access: "read" },
          { op: "next" }
        ]
      },
      {
        instructionId: "store-root",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
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
            b: c32Expr(1)
          },
          {
            op: "set",
            target: { kind: "mem", address: { kind: "var", id: 1 } },
            value: { kind: "var", id: 1 },
            accessWidth: 32
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "branch-root",
        eip: startAddress + 2,
        nextEip: startAddress + 3,
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
            b: c32Expr(1)
          },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: { kind: "var", id: 1 }, accessWidth: 32 },
          {
            op: "conditionalJump",
            condition: { kind: "var", id: 1 },
            taken: { kind: "var", id: 1 },
            notTaken: { kind: "nextEip" }
          }
        ]
      },
      {
        instructionId: "trap-root",
        eip: startAddress + 3,
        nextEip: startAddress + 4,
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
            b: c32Expr(1)
          },
          { op: "hostTrap", vector: { kind: "var", id: 1 } }
        ]
      }
    ]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const expectedValue = {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: jitInputReg32Value("eax"),
    b: c32(1)
  } as const;
  const purposes = emissionPlan.plannedEffects.flatMap((effect) =>
    effect.valueRoots.map((root) => root.purpose)
  );
  const usePurposes = emissionPlan.valueUses
    .filter((use) => valuesEqual(use.value, expectedValue))
    .map((use) => use.purpose);

  deepStrictEqual(emissionPlan.plannedEffects.map((effect) => effect.kind), [
    "memoryGuard",
    "memoryStore",
    "branch",
    "hostTrap"
  ]);
  strictEqual(purposes.includes("memoryAddress"), true);
  strictEqual(purposes.includes("memoryValue"), true);
  strictEqual(purposes.includes("branchCondition"), true);
  strictEqual(purposes.includes("branchTarget"), true);
  strictEqual(purposes.includes("trapVector"), true);
  deepStrictEqual(usePurposes.includes("exitStore"), true);
  strictEqual(emissionPlan.reusePlan.cache.selected.some((entry) =>
    valuesEqual(entry.value, expectedValue)
  ), true);
});

test("JIT effect plan selects produced values only for later required roots", () => {
  const unusedBlock: JitBlock = {
    instructions: [{
      instructionId: "unused-produced",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: c32Expr(0x1000) },
          accessWidth: 32
        },
        { op: "next" }
      ]
    }]
  };
  const usedBlock: JitBlock = {
    instructions: [{
      instructionId: "used-produced",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "exit",
      operands: [],
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: c32Expr(0x1000) },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "var", id: 0 } }
      ]
    }]
  };
  const unusedPlan = buildJitCodegenEmissionPlan(planJitCodegen(unusedBlock));
  const usedPlan = buildJitCodegenEmissionPlan(planJitCodegen(usedBlock));
  const produced = jitProducedValue("load#used-produced:0:0:0", "i32");

  deepStrictEqual(unusedPlan.plannedEffects.map((effect) => effect.kind), [
    "producedValue"
  ]);
  deepStrictEqual(unusedPlan.valueUses, []);
  deepStrictEqual(unusedPlan.reusePlan.cache.selected, []);
  deepStrictEqual(unusedPlan.reusePlan.captures.captures, []);

  deepStrictEqual(usedPlan.plannedEffects.map((effect) => effect.kind), [
    "producedValue",
    "hostTrap"
  ]);
  deepStrictEqual(usedPlan.reusePlan.cache.selected, [
    { value: produced, useCount: 1 }
  ]);
  deepStrictEqual(
    usedPlan.reusePlan.captures.captures
      .filter((capture) => capture.reason === "producedDefinition")
      .map((capture) => capture.value),
    [produced]
  );
});
