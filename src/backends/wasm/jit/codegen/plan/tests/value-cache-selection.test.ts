import {
  deepStrictEqual,
  test,
  addValue,
  c32,
  jitInputReg32Value,
  jitProducedValue
} from "./plan-test-helpers.js";
import { planJitValueCacheSelection } from "#backends/wasm/jit/codegen/plan/value-cache-selection.js";

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
      { value: repeated, emittedCost: 3, ancestors: [] },
      { value: repeated, emittedCost: 3, ancestors: [] }
    ],
    [
      { value: produced, emittedCost: 1, ancestors: [] }
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
