import {
  deepStrictEqual,
  strictEqual,
  throws,
  test,
  buildJitCodegenEmissionPlan,
  buildTimeline,
  c32,
  c32Expr,
  createJitValueState,
  exitPoint,
  ExitReason,
  jitInputReg32Value,
  jitProducedValue,
  planJitCodegen,
  rootPath,
  IR_ALU_FLAG_MASK,
  startAddress,
  type PlannedExit,
  type JitBlock
} from "./plan-test-helpers.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import {
  planEffects
} from "#backends/wasm/jit/codegen/plan/effects-plan.js";
import type { Effect } from "#backends/wasm/jit/codegen/plan/effect-types.js";

test("JIT effects plan leaves pure expressions and state updates out of cache roots", () => {
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

  deepStrictEqual(emissionPlan.effects, []);
  deepStrictEqual(emissionPlan.valueUses, []);
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, []);
});

test("JIT effects plan resolves operands, preserves order, and carries exact exits", () => {
  const block: JitBlock = {
    instructions: [
      {
        instructionId: "schedule-guard",
        eip: startAddress,
        nextEip: startAddress + 1,
        nextMode: "continue",
        operands: [],
        ir: [
          { op: "memory.guard", address: c32Expr(0x60), byteLength: 4, access: "read" },
          { op: "next" }
        ]
      },
      {
        instructionId: "schedule-store",
        eip: startAddress + 1,
        nextEip: startAddress + 2,
        nextMode: "continue",
        operands: [],
        ir: [
          {
            op: "set",
            target: { kind: "mem", address: c32Expr(0x64) },
            value: c32Expr(0x55),
            accessWidth: 32
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "schedule-produced",
        eip: startAddress + 2,
        nextEip: startAddress + 3,
        nextMode: "continue",
        operands: [],
        ir: [
          {
            op: "get",
            dst: { kind: "var", id: 0 },
            source: { kind: "mem", address: c32Expr(0x68) },
            accessWidth: 16
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "schedule-jump",
        eip: startAddress + 3,
        nextEip: startAddress + 4,
        nextMode: "exit",
        operands: [],
        ir: [
          { op: "jump", target: c32Expr(0x2000) }
        ]
      },
      {
        instructionId: "schedule-branch",
        eip: startAddress + 4,
        nextEip: startAddress + 5,
        nextMode: "exit",
        operands: [],
        ir: [
          {
            op: "conditionalJump",
            condition: c32Expr(1),
            taken: c32Expr(0x3000),
            notTaken: { kind: "nextEip" }
          }
        ]
      },
      {
        instructionId: "schedule-trap",
        eip: startAddress + 5,
        nextEip: startAddress + 6,
        nextMode: "exit",
        operands: [],
        ir: [
          { op: "hostTrap", vector: c32Expr(0x2e) }
        ]
      },
      {
        instructionId: "schedule-fallthrough",
        eip: startAddress + 6,
        nextEip: startAddress + 7,
        nextMode: "exit",
        operands: [],
        ir: [
          { op: "next" }
        ]
      }
    ]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const effects = emissionPlan.effects;

  deepStrictEqual(effects.map((effect) => effect.kind), [
    "memoryGuard",
    "memoryStore",
    "producedValue",
    "jump",
    "branch",
    "hostTrap",
    "fallthrough"
  ]);

  const guard = requireEffect(effects[0], "memoryGuard");
  deepStrictEqual(guard.address, c32(0x60));
  strictEqual(guard.byteLength, 4);
  strictEqual(guard.access, "read");
  assertExactExit(guard.exit, emissionPlan.exits);

  const store = requireEffect(effects[1], "memoryStore");
  deepStrictEqual(store.address, c32(0x64));
  deepStrictEqual(store.value, c32(0x55));
  strictEqual(store.accessWidth, 32);

  const produced = requireEffect(effects[2], "producedValue");
  deepStrictEqual(produced.value, jitProducedValue("load#schedule-produced:2:0:0", "i32"));
  deepStrictEqual(produced.address, c32(0x68));
  strictEqual(produced.accessWidth, 16);
  strictEqual(produced.signed, false);

  const jump = requireEffect(effects[3], "jump");
  deepStrictEqual(jump.target, c32(0x2000));
  assertExactExit(jump.exit, emissionPlan.exits);

  const branch = requireEffect(effects[4], "branch");
  deepStrictEqual(branch.condition, c32(1));
  deepStrictEqual(branch.takenTarget, c32(0x3000));
  deepStrictEqual(branch.notTakenTarget, c32(startAddress + 5));
  assertExactExit(branch.taken, emissionPlan.exits);
  assertExactExit(branch.notTaken, emissionPlan.exits);
  strictEqual(branch.taken.id !== branch.notTaken.id, true);

  const trap = requireEffect(effects[5], "hostTrap");
  deepStrictEqual(trap.vector, c32(0x2e));
  assertExactExit(trap.exit, emissionPlan.exits);

  const fallthrough = requireEffect(effects[6], "fallthrough");
  assertExactExit(fallthrough.exit, emissionPlan.exits);
  strictEqual(fallthrough.exit.reason, ExitReason.FALLTHROUGH);
});

test("JIT effects plan omits local fallthrough effects", () => {
  const block: JitBlock = {
    instructions: [{
      instructionId: "local-fallthrough",
      eip: startAddress,
      nextEip: startAddress + 1,
      nextMode: "continue",
      operands: [],
      ir: [{ op: "next" }]
    }]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));

  deepStrictEqual(emissionPlan.effects, []);
});

test("JIT effects plan fails before emission for unresolved effect values", () => {
  const valueState = createJitValueState().snapshot();
  const expressionBlock = [
    { op: "hostTrap", vector: { kind: "var", id: 99 } }
  ] as const;
  const exit = exitPoint({
    instructionIndex: 0,
    opIndex: 0,
    kind: "hostTrap",
    reason: ExitReason.HOST_TRAP,
    snapshot: {
      instructionCountDelta: 0,
      valueState
    },
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    path: rootPath(),
    exitStoreIndex: 0
  });

  throws(() => {
    planEffects({
      effects: [{
        kind: "hostTrap",
        at: { instructionIndex: 0, opIndex: 0 },
        exit
      }],
      instructions: [{
        ir: expressionBlock,
        nextEip: startAddress + 1,
        expressionBlock,
        sourceExpressionMap: {
          placementsBySourceOpIndex: new Map([[
            0,
            [{ kind: "emittedOp", expressionOpIndex: 0 }]
          ]])
        },
        valueTimeline: buildTimeline({
          operands: [],
          expressions: expressionBlock,
          entry: valueState
        })
      }]
    });
  }, /JIT value expression is not available in the JIT timeline/);
});

test("JIT effects plan attaches roots for ordered effects and exit stores", () => {
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
  const purposes = emissionPlan.valueUses.map((use) => use.purpose);
  const usePurposes = emissionPlan.valueUses
    .filter((use) => valuesEqual(use.value, expectedValue))
    .map((use) => use.purpose);

  deepStrictEqual(emissionPlan.effects.map((effect) => effect.kind), [
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

test("JIT effects plan selects produced values only for later required roots", () => {
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

  deepStrictEqual(unusedPlan.effects.map((effect) => effect.kind), [
    "producedValue"
  ]);
  deepStrictEqual(unusedPlan.valueUses, []);
  deepStrictEqual(unusedPlan.reusePlan.cache.selected, []);
  deepStrictEqual(unusedPlan.reusePlan.captures.captures, []);

  deepStrictEqual(usedPlan.effects.map((effect) => effect.kind), [
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

function requireEffect<TKind extends Effect["kind"]>(
  effect: Effect | undefined,
  kind: TKind
): Extract<Effect, { kind: TKind }> {
  strictEqual(effect?.kind, kind);

  return effect as Extract<Effect, { kind: TKind }>;
}

function assertExactExit(
  exit: PlannedExit,
  exits: readonly PlannedExit[]
): void {
  strictEqual(exits.find((entry) => entry.id === exit.id), exit);
}
