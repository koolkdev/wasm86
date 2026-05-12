import { throws } from "node:assert";
import { test } from "node:test";

import { validateJitIrBlock } from "#backends/wasm/jit/ir/validate.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { startAddress, v } from "./helpers.js";

test("validateJitIrBlock rejects operand indexes before effect analysis", () => {
  throws(() => validateJitIrBlock(jitBlock([
    { op: "get", dst: v(0), source: { kind: "operand", index: 0 } },
    { op: "next" }
  ])), /IR operand 0 does not exist in 0-operand instruction/);
});

function jitBlock(ir: IrBlock): JitIrBlock {
  return { instructions: [jitInstruction(ir)] };
}

function jitInstruction(ir: IrBlock): JitIrBlockInstruction {
  return {
    instructionId: "synthetic.verifier",
    eip: startAddress,
    nextEip: startAddress + 1,
    nextMode: "continue",
    operands: [],
    ir
  };
}
