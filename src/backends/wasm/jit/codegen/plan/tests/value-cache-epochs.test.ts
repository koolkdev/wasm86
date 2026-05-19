import {
  deepStrictEqual,
  test,
  buildTimeline,
  createJitValueState,
  jitLoadResultValue,
  rootPath
} from "./plan-test-helpers.js";
import { buildEpochs } from "#backends/wasm/jit/codegen/plan/epochs.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT value-cache epoch planning exposes instruction epochs and load-result definitions", () => {
  const loadResult = jitLoadResultValue(0, "i32");
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
    snapshotPoints: new Set()
  });
  const plannedUse: ValueUse = {
    value: loadResult,
    at: { instructionIndex: 0, opIndex: 2, epoch: 1 },
    path: rootPath(),
    purpose: "trapVector",
    root: loadResult,
    ancestors: []
  };
  const epoch = buildEpochs([{
    operands: [],
    expressionBlock,
    valueTimeline
  }], [plannedUse]);

  deepStrictEqual(epoch.instructions[0]?.opEpochs, [0, 0, 1]);
  deepStrictEqual(epoch.loadResults.map((definition) => ({
    value: definition.value,
    at: definition.at
  })), [{
    value: loadResult,
    at: { instructionIndex: 0, opIndex: 0, epoch: 0 }
  }]);
  deepStrictEqual(epoch.epochs.map((entry) => entry.uses), [[], [plannedUse]]);
});
