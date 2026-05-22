import {
  deepStrictEqual,
  blockExpressionsForTest,
  test,
  buildTimeline,
  jitLoadResultValue,
  rootPath
} from "./plan-test-helpers.js";
import { buildEpochs } from "#backends/wasm/jit/codegen/plan/epochs.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT value-cache epoch planning exposes block epochs and memory-load values", () => {
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
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });
  const plannedUse: ValueUse = {
    value: loadResult,
    at: { opIndex: 2, epoch: 1 },
    path: rootPath(),
    purpose: "trapVector",
    root: loadResult,
    ancestors: []
  };
  const epoch = buildEpochs({
    expressions: blockExpressionsForTest(expressionBlock),
    valueTimeline
  }, [plannedUse]);

  deepStrictEqual(epoch.block.opEpochs, [0, 0, 1]);
  deepStrictEqual(epoch.memoryLoadValues.map((memoryLoadValue) => ({
    value: memoryLoadValue.value,
    at: memoryLoadValue.at
  })), [{
    value: loadResult,
    at: { opIndex: 0, epoch: 0 }
  }]);
  deepStrictEqual(epoch.epochs.map((entry) => entry.uses), [[], [plannedUse]]);
});
