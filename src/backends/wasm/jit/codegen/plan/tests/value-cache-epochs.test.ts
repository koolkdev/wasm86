import {
  deepStrictEqual,
  test,
  buildTimeline,
  createJitValueState,
  jitProducedValue,
  rootPath
} from "./plan-test-helpers.js";
import { planJitValueCacheEpochs } from "#backends/wasm/jit/codegen/plan/value-cache-epochs.js";
import type { JitPlannedValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT value-cache epoch planning exposes instruction epochs and produced definition captures", () => {
  const produced = jitProducedValue("epoch:produced", "i32");
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
    { op: "hostTrap", vector: { kind: "var", id: 0 } }
  ] as const;
  const valueTimeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot(),
    producedByVar: new Map([[0, produced]])
  });
  const plannedUse: JitPlannedValueUse = {
    value: produced,
    placement: { instructionIndex: 0, opIndex: 2, epoch: 1 },
    path: rootPath(),
    purpose: "expression"
  };
  const epoch = planJitValueCacheEpochs([{
    operands: [],
    expressionBlock,
    valueTimeline
  }], [plannedUse]);

  deepStrictEqual(epoch.instructions[0]?.opEpochs, [0, 0, 1]);
  deepStrictEqual(epoch.definitionCaptures, [[produced], []]);
  deepStrictEqual(epoch.consumerUses, [[], [{
    value: plannedUse.value,
    emittedCost: 1,
    ancestors: []
  }]]);
});
