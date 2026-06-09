import {
  deepStrictEqual,
  strictEqual,
  test,
  buildJitCodegenEmissionPlan,
  c32,
  c32Expr,
  ExitReason,
  jitInputReg32Value,
  jitLoadResultValue,
  planJitCodegen,
  startAddress,
  type Exit,
  type PlannedExit,
  type JitIrBlock
} from "./plan-test-helpers.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { BlockScheduleEntry } from "#backends/wasm/jit/codegen/plan/schedule-types.js";

test("JIT schedule treats final fallthrough state as exit-store roots", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "state-updates-only",
      eip: startAddress,
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
          op: "flags.write",
          cells: {
            CF: { kind: "expr", value: { kind: "var", id: 1 } },
            PF: { kind: "expr", value: { kind: "var", id: 1 } },
            AF: { kind: "expr", value: { kind: "var", id: 1 } },
            ZF: { kind: "expr", value: { kind: "var", id: 1 } },
            SF: { kind: "expr", value: { kind: "var", id: 1 } },
            OF: { kind: "expr", value: { kind: "var", id: 1 } }
          }
        },
        { op: "next" }
      ]
    }]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));

  deepStrictEqual(emissionPlan.schedule.map((entry) => entry.kind), ["fallthrough"]);
  strictEqual(emissionPlan.valueUses.every((use) => use.purpose === "exitStore"), true);
  strictEqual(emissionPlan.reusePlan.cache.selected.some((entry) =>
    entry.value.kind === "value.binary"
  ), true);
});

test("JIT schedule resolves operands, preserves order, and carries exact exits", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "effect-guard",
        eip: startAddress,
        ir: [
          { op: "memory.guard", address: c32Expr(0x60), byteLength: 4, access: "read" },
          { op: "next" }
        ]
      },
      {
        instructionId: "effect-store",
        eip: startAddress + 1,
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
        instructionId: "load-result",
        eip: startAddress + 2,
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
        instructionId: "effect-jump",
        eip: startAddress + 3,
        ir: [
          { op: "jump", target: c32Expr(0x2000) }
        ]
      },
      {
        instructionId: "effect-branch",
        eip: startAddress + 4,
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
        instructionId: "effect-trap",
        eip: startAddress + 5,
        ir: [
          { op: "hostTrap", vector: c32Expr(0x2e) }
        ]
      },
      {
        instructionId: "effect-fallthrough",
        eip: startAddress + 6,
        ir: [
          { op: "next" }
        ]
      }
    ]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const schedule = emissionPlan.schedule;

  deepStrictEqual(schedule.map((entry) => entry.kind), [
    "memoryGuard",
    "memoryStore",
    "defineLoadResult",
    "jump",
    "branch",
    "hostTrap",
    "fallthrough"
  ]);

  const guard = requireScheduleEntry(schedule[0], "memoryGuard");
  deepStrictEqual(guard.address, c32(0x60));
  strictEqual(guard.byteLength, 4);
  strictEqual(guard.access, "read");
  assertExactExit(guard.exit, emissionPlan.exits);

  const store = requireScheduleEntry(schedule[1], "memoryStore");
  deepStrictEqual(store.address, c32(0x64));
  deepStrictEqual(store.value, c32(0x55));
  strictEqual(store.width, 32);

  const load = requireScheduleEntry(schedule[2], "defineLoadResult");
  deepStrictEqual(load.result, jitLoadResultValue(0, "i32"));
  deepStrictEqual(load.address, c32(0x68));
  strictEqual(load.width, 16);

  const jump = requireScheduleEntry(schedule[3], "jump");
  deepStrictEqual(jump.target, c32(0x2000));
  assertExactExit(jump.exit, emissionPlan.exits);

  const branch = requireScheduleEntry(schedule[4], "branch");
  deepStrictEqual(branch.condition, c32(1));
  deepStrictEqual(branch.takenTarget, c32(0x3000));
  deepStrictEqual(branch.notTakenTarget, c32(startAddress + 5));
  assertExactExit(branch.taken, emissionPlan.exits);
  assertExactExit(branch.notTaken, emissionPlan.exits);
  strictEqual(branch.taken.id !== branch.notTaken.id, true);

  const trap = requireScheduleEntry(schedule[5], "hostTrap");
  deepStrictEqual(trap.vector, c32(0x2e));
  assertExactExit(trap.exit, emissionPlan.exits);

  const fallthrough = requireScheduleEntry(schedule[6], "fallthrough");
  assertExactExit(fallthrough.exit, emissionPlan.exits);
  strictEqual(fallthrough.exit.reason, ExitReason.FALLTHROUGH);
});

test("JIT schedule omits local fallthrough entries", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "local-fallthrough",
        eip: startAddress,
        ir: [{ op: "next" }]
      },
      {
        instructionId: "final-jump",
        eip: startAddress + 1,
        ir: [{ op: "jump", target: c32Expr(0x2000) }]
      }
    ]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));

  deepStrictEqual(emissionPlan.schedule.map((entry) => entry.kind), ["jump"]);
});

test("JIT schedule attaches roots for ordered runtime actions and exit stores", () => {
  const block: JitIrBlock = {
    instructions: [
      {
        instructionId: "guard-root",
        eip: startAddress,
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
        ir: [
          { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 3 },
            a: { kind: "var", id: 2 },
            b: c32Expr(1)
          },
          {
            op: "set",
            target: { kind: "mem", address: { kind: "var", id: 3 } },
            value: { kind: "var", id: 3 },
            accessWidth: 32
          },
          { op: "next" }
        ]
      },
      {
        instructionId: "branch-root",
        eip: startAddress + 2,
        ir: [
          { op: "get", dst: { kind: "var", id: 4 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 5 },
            a: { kind: "var", id: 4 },
            b: c32Expr(1)
          },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: { kind: "var", id: 5 }, accessWidth: 32 },
          {
            op: "conditionalJump",
            condition: { kind: "var", id: 5 },
            taken: { kind: "var", id: 5 },
            notTaken: { kind: "nextEip" }
          }
        ]
      },
      {
        instructionId: "trap-root",
        eip: startAddress + 3,
        ir: [
          { op: "get", dst: { kind: "var", id: 6 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
          {
            op: "value.binary",
            type: "i32",
            operator: "add",
            dst: { kind: "var", id: 7 },
            a: { kind: "var", id: 6 },
            b: c32Expr(1)
          },
          { op: "hostTrap", vector: { kind: "var", id: 7 } }
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

  deepStrictEqual(emissionPlan.schedule.map((entry) => entry.kind), [
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

test("JIT schedule selects load-result values only for later required roots", () => {
  const unusedBlock: JitIrBlock = {
    instructions: [{
      instructionId: "unused-loadResult",
      eip: startAddress,
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
  const usedBlock: JitIrBlock = {
    instructions: [{
      instructionId: "used-loadResult",
      eip: startAddress,
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
  const loadResult = jitLoadResultValue(0, "i32");

  deepStrictEqual(unusedPlan.schedule.map((entry) => entry.kind), [
    "defineLoadResult",
    "fallthrough"
  ]);
  deepStrictEqual(unusedPlan.valueUses, []);
  deepStrictEqual(unusedPlan.reusePlan.cache.selected, []);
  deepStrictEqual(unusedPlan.reusePlan.captures.captures, []);

  deepStrictEqual(usedPlan.schedule.map((entry) => entry.kind), [
    "defineLoadResult",
    "hostTrap"
  ]);
  deepStrictEqual(usedPlan.reusePlan.cache.selected, [
    { value: loadResult, useCount: 1 }
  ]);
  deepStrictEqual(
    usedPlan.reusePlan.captures.captures
      .filter((capture) => capture.reason === "memoryLoadValue")
      .map((capture) => capture.value),
    [loadResult]
  );
});

test("JIT schedule roots live memory-load value addresses transitively", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "chained-loadResult-address",
      eip: startAddress,
      ir: [
        {
          op: "get",
          dst: { kind: "var", id: 0 },
          source: { kind: "mem", address: c32Expr(0x60) },
          accessWidth: 32
        },
        {
          op: "get",
          dst: { kind: "var", id: 1 },
          source: { kind: "mem", address: { kind: "var", id: 0 } },
          accessWidth: 32
        },
        { op: "hostTrap", vector: { kind: "var", id: 1 } }
      ]
    }]
  };
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const firstLoad = jitLoadResultValue(0, "i32");
  const secondLoad = jitLoadResultValue(1, "i32");

  strictEqual(emissionPlan.reusePlan.cache.selected.some((entry) =>
    valuesEqual(entry.value, firstLoad)
  ), true);
  strictEqual(emissionPlan.reusePlan.cache.selected.some((entry) =>
    valuesEqual(entry.value, secondLoad)
  ), true);
  strictEqual(emissionPlan.valueUses.some((use) =>
    valuesEqual(use.value, firstLoad) &&
      valuesEqual(use.root, firstLoad) &&
      use.purpose === "memoryAddress"
  ), true);
});

function requireScheduleEntry<TKind extends BlockScheduleEntry["kind"]>(
  effect: BlockScheduleEntry | undefined,
  kind: TKind
): Extract<BlockScheduleEntry, { kind: TKind }> {
  strictEqual(effect?.kind, kind);

  return effect as Extract<BlockScheduleEntry, { kind: TKind }>;
}

function assertExactExit(
  exit: Exit,
  exits: readonly PlannedExit[]
): void {
  strictEqual(exits.find((entry) => entry.id === exit.id), exit);
}
