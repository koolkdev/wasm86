import {
  deepStrictEqual,
  test,
  addValue,
  c32,
  jitInputReg32Value,
  jitProducedValue
} from "./plan-test-helpers.js";
import { planJitValueCacheSelection } from "#backends/wasm/jit/codegen/plan/value-cache-selection.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT value-cache selection returns an empty total plan when no values are selected", () => {
  const selection = planJitValueCacheSelection([[], []]);

  deepStrictEqual(selection, {
    consumers: [[], []],
    useCounts: []
  });
});

test("JIT value-cache selection exposes per-epoch consumers and merged use counts", () => {
  const repeated = addValue(jitInputReg32Value("eax"), c32(1));
  const produced = jitProducedValue("selection:produced", "i32");
  const selection = planJitValueCacheSelection([
    [
      valueUse(repeated),
      valueUse(repeated)
    ],
    [
      valueUse(produced)
    ]
  ]);

  deepStrictEqual(selection.consumers, [
    [{ value: repeated, useCount: 2 }],
    [{ value: produced, useCount: 1 }]
  ]);
  deepStrictEqual(selection.useCounts, [
    { value: repeated, useCount: 2 },
    { value: produced, useCount: 1 }
  ]);
});

function valueUse(
  value: JitValue,
  ancestors: readonly JitValue[] = []
): ValueUse {
  return {
    value,
    at: { instructionIndex: 0, opIndex: 0, epoch: 0 },
    path: { kind: "path", id: "root" },
    purpose: "trapVector",
    root: ancestors[0] ?? value,
    ancestors
  };
}
