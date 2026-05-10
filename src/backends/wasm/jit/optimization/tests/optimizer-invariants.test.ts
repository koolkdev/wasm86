import { throws } from "node:assert";
import { test } from "node:test";

import { validateJitIrBlock } from "#backends/wasm/jit/ir/validate.js";
import type { JitIrBlock, JitIrBlockInstruction, JitIrBody } from "#backends/wasm/jit/ir/types.js";
import { c32, startAddress, v } from "./helpers.js";

test("validateJitIrBlock rejects operand indexes before effect analysis", () => {
  throws(() => validateJitIrBlock(jitBlock([
    { op: "get", dst: v(0), source: { kind: "operand", index: 0 } },
    { op: "next" }
  ])), /IR operand 0 does not exist in 0-operand instruction/);
});

test("validateJitIrBlock rejects non-register materialization targets", () => {
  throws(() => validateJitIrBlock(jitBlock([
    {
      op: "set",
      role: "registerMaterialization",
      target: { kind: "mem", address: c32(0x2000) },
      value: c32(1)
    },
    { op: "next" }
  ])), /register materialization cannot target mem/);
});

function jitBlock(ir: JitIrBody): JitIrBlock {
  return { instructions: [jitInstruction(ir)] };
}

function jitInstruction(ir: JitIrBody): JitIrBlockInstruction {
  return {
    instructionId: "synthetic.verifier",
    eip: startAddress,
    nextEip: startAddress + 1,
    nextMode: "continue",
    operands: [],
    ir
  };
}
