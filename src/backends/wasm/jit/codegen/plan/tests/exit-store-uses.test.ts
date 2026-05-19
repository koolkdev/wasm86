import {
  deepStrictEqual,
  test,
  FLAG_PRODUCERS,
  ExitReason,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  jitFlagConditionValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  jitProducedValue,
  onlyExit,
  startAddress,
  registerStore,
  flagStore,
  exitPoint,
  exitState,
  c32,
  addValue,
  analyzeBlockForTest,
  plannedInstructionsForTest,
  type JitCodegenPlan,
  type ExitStore,
  type JitValue,
  type JitIrBlock
} from "./plan-test-helpers.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("planJitCodegen leaves exit-store sources on exits and omits separate exit-store-use records", () => {
  const block: JitIrBlock = {
    instructions: [{
      instructionId: "canonical-produced-exit-store",
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
  const produced = jitProducedValue("load#canonical-produced-exit-store:0:1:0", "i32");
  const exitValue = addValue(produced, jitInputReg32Value("ebx"));
  const [exitStoreUse] = rootUses(emissionPlan.valueUses, exitValue, "exitStore");
  const hostTrapOpIndex = emissionPlan.instructions[0]?.analysis.expressions.block
    .findIndex((op) => op.op === "hostTrap");

  deepStrictEqual(exit.stores, [registerStore("eax", exitValue)]);
  deepStrictEqual(exitStoreUse?.at, { instructionIndex: 0, opIndex: hostTrapOpIndex, epoch: 1 });
  deepStrictEqual(exitStoreUse?.path, exit.path);
  deepStrictEqual(exitStoreUse?.ancestors, []);
  deepStrictEqual(
    emissionPlan.valueUses
      .filter((use) => valuesEqual(use.root, exitValue))
      .map((use) => use.value),
    [exitValue, produced, jitInputReg32Value("ebx")]
  );
});

test("buildJitCodegenEmissionPlan counts repeated register and flag store dependencies through canonical value uses", () => {
  const commonValue = addValue(jitInputReg32Value("eax"), c32(1));
  const emissionPlan = buildHostTrapEmissionPlanForStores("canonical-store-use-counts", [
    registerStore("ebx", commonValue),
    flagStore(commonValue)
  ]);

  deepStrictEqual(
    rootUses(emissionPlan.valueUses, commonValue, "exitStore").map((use) => use.value),
    [commonValue, commonValue]
  );
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, [
    { value: commonValue, useCount: 2 }
  ]);
});

test("buildJitCodegenEmissionPlan expands exit-store dependency trees once with root ancestry", () => {
  const produced = jitProducedValue("load#canonical-select-dependencies:0:0:0", "i32");
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
  const emissionPlan = buildHostTrapEmissionPlanForStores("canonical-select-dependencies", [
    flagStore(selectedFlags)
  ]);
  const producedUse = emissionPlan.valueUses.find((use) =>
    valuesEqual(use.value, produced) &&
      valuesEqual(use.root, selectedFlags)
  );

  deepStrictEqual(producedUse?.ancestors, [
    selectedFlags,
    jitFlagConditionValue(conditionFlags, "E"),
    conditionFlags
  ]);
  deepStrictEqual(
    emissionPlan.reusePlan.captures.captures
      .filter((capture) => capture.reason === "producedDefinition")
      .map((capture) => capture.value),
    [produced]
  );
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, [
    { value: produced, useCount: 1 }
  ]);
});

function buildHostTrapEmissionPlanForStores(
  instructionId: string,
  stores: readonly ExitStore[]
) {
  const block: JitIrBlock = {
    instructions: [{
      instructionId,
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
  const postSnapshot = exitState(1);
  const exit = exitPoint({
    instructionIndex: 0,
    opIndex: 1,
    reason: ExitReason.HOST_TRAP,
    snapshot: postSnapshot,
    visibleEip: { kind: "static", value: startAddress + 1 },
    payload: { kind: "runtime", source: "hostTrapVector" },
    stores,
    exitStoreIndex: 1
  });
  const analysis = analyzeBlockForTest(block);
  const plan: JitCodegenPlan = {
    analysis,
    instructions: plannedInstructionsForTest(analysis, [exit]),
    exits: [exit]
  };

  return buildJitCodegenEmissionPlan(plan);
}

function rootUses(
  uses: readonly ValueUse[],
  root: JitValue,
  purpose: ValueUse["purpose"]
): readonly ValueUse[] {
  return uses.filter((use) =>
    valuesEqual(use.value, root) &&
      valuesEqual(use.root, root) &&
      use.purpose === purpose
  );
}
