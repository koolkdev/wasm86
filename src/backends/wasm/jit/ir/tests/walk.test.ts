import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  jitLocation,
  walkJitOpsBetween
} from "#backends/wasm/jit/ir/walk.js";
import { syntheticInstruction, v } from "./helpers.js";

test("walkJitOpsBetween iterates between locations", () => {
  const block = {
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 1 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "next" }
      ]),
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 2 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(0) },
        { op: "next" }
      ], 1)
    ]
  };
  const visited: string[] = [];

  walkJitOpsBetween(block, jitLocation(0, 0), jitLocation(1, 1), (_instruction, op, location) => {
    visited.push(`${location.instructionIndex}:${location.opIndex}:${op.op}`);
  });

  deepStrictEqual(visited, ["0:1:set", "0:2:next", "1:0:value.const"]);
});
