import {
  deepStrictEqual,
  test,
  addValue,
  c32,
  jitInputReg32Value,
  jitProducedValue
} from "./plan-test-helpers.js";
import { selectCacheValues } from "#backends/wasm/jit/codegen/plan/cache.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT value-cache selection returns an empty total plan when no values are selected", () => {
  const selection = selectCacheValues([[], []]);

  deepStrictEqual(selection, {
    consumers: [[], []],
    selected: []
  });
});

test("JIT value-cache selection exposes per-epoch consumers and merged use counts", () => {
  const repeated = addValue(jitInputReg32Value("eax"), c32(1));
  const produced = jitProducedValue("selection:produced", "i32");
  const selection = selectCacheValues([
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
  deepStrictEqual(selection.selected, [
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
