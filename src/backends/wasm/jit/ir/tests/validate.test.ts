import { throws } from "node:assert";
import { test } from "node:test";

import { validateBlock } from "#backends/wasm/jit/ir/validate.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import type { JitBlock, JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { startAddress, v } from "./helpers.js";

test("validateBlock rejects empty blocks", () => {
  throws(() => validateBlock({ instructions: [] }), /cannot validate empty JIT block/);
});

test("validateBlock rejects invalid operand indexes", () => {
  throws(() => validateBlock(jitBlock([
    { op: "get", dst: v(0), source: { kind: "operand", index: 0 } },
    { op: "next" }
  ])), /IR operand 0 does not exist in 0-operand instruction/);
});

test("validateBlock treats value namespaces as instruction-local", () => {
  validateBlock({
    instructions: [
      jitInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "next" }
      ]),
      jitInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "ebx" } },
        { op: "next" }
      ], 1, "exit")
    ]
  });
});

test("validateBlock rejects non-final non-fallthrough instructions", () => {
  throws(() => validateBlock({
    instructions: [
      jitInstruction([
        { op: "jump", target: { kind: "const", type: "i32", value: startAddress + 8 } }
      ]),
      jitInstruction([{ op: "next" }], 1)
    ]
  }), /non-final JIT instruction must fall through/);
});

test("validateBlock rejects final continuing instructions", () => {
  throws(() => validateBlock(jitBlock([
    { op: "next" }
  ], "continue")), /final JIT instruction must exit/);

  throws(() => validateBlock({
    instructions: [
      jitInstruction([{ op: "next" }]),
      jitInstruction([{ op: "next" }], 1, "continue")
    ]
  }), /final JIT instruction must exit/);
});

test("validateBlock allows final exiting instructions", () => {
  validateBlock(jitBlock([
    { op: "jump", target: { kind: "const", type: "i32", value: startAddress + 8 } }
  ], "exit"));
});

test("validateBlock rejects ops outside shared x86 IR", () => {
  throws(() => validateBlock(jitBlock([
    { op: "jit.cache" },
    { op: "next" }
  ] as unknown as IrBlock)), /unhandled IR op semantics/);
});

function jitBlock(ir: IrBlock, nextMode: JitInstruction["nextMode"] = "continue"): JitBlock {
  return { instructions: [jitInstruction(ir, 0, nextMode)] };
}

function jitInstruction(
  ir: IrBlock,
  index = 0,
  nextMode: JitInstruction["nextMode"] = "continue"
): JitInstruction {
  return {
    instructionId: "synthetic.verifier",
    eip: startAddress + index,
    nextEip: startAddress + index + 1,
    nextMode,
    operands: [],
    ir
  };
}
