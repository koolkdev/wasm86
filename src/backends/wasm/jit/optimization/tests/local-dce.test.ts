import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { runJitOptimizationPasses } from "#backends/wasm/jit/optimization/pass.js";
import { localDcePass, pruneDeadJitLocalValues } from "#backends/wasm/jit/optimization/passes/local-dce.js";
import { c32, syntheticInstruction, v } from "./helpers.js";

test("local-dce removes unused pure local values", () => {
  const result = pruneDeadJitLocalValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 1 },
        { op: "value.const", type: "i32", dst: v(1), value: 2 },
        { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: v(1) },
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.localDce.removedOpCount, 3);
  deepStrictEqual(result.block.instructions[0]?.ir.map((op) => op.op), ["next"]);
});

test("local-dce removes dead memory reads and keeps explicit guards", () => {
  const result = pruneDeadJitLocalValues({
    instructions: [
      syntheticInstruction([
        { op: "memory.guard", address: c32(0x2000), byteLength: 4, access: "read" },
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.localDce.removedOpCount, 1);
  deepStrictEqual(result.block.instructions[0]?.ir.map((op) => op.op), ["memory.guard", "next"]);
});

test("local-dce removes dead non-faulting register reads", () => {
  const result = pruneDeadJitLocalValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "next" }
      ])
    ]
  });

  strictEqual(result.localDce.removedOpCount, 1);
  deepStrictEqual(result.block.instructions[0]?.ir.map((op) => op.op), ["next"]);
});

test("local-dce is a validating repeatable optimization pass", () => {
  const first = runJitOptimizationPasses({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 1 },
        { op: "next" }
      ])
    ]
  }, [localDcePass], { validate: true });
  const second = runJitOptimizationPasses(first.block, [localDcePass], { validate: true });

  strictEqual(first.changed, true);
  deepStrictEqual(first.passes[0]?.stats, { removedOpCount: 1 });
  strictEqual(second.changed, false);
  deepStrictEqual(second.passes[0]?.stats, { removedOpCount: 0 });
  deepStrictEqual(second.block.instructions[0]?.ir.map((op) => op.op), ["next"]);
});
