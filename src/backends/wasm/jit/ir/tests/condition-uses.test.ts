import { throws } from "node:assert";
import { test } from "node:test";

import { analyzeJitConditionUses } from "#backends/wasm/jit/ir/condition-uses.js";
import { syntheticInstruction, v } from "./helpers.js";

test("JIT condition use analysis rejects ordinary condition value uses", () => {
  throws(
    () => analyzeJitConditionUses({
      instructions: [
        syntheticInstruction([
          { op: "flags.condition", dst: v(0), cc: "E" },
          { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(0) },
          { op: "next" }
        ])
      ]
    }),
    /JIT condition value 0 is used as an ordinary value/
  );
});
