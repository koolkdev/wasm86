import { throws } from "node:assert";
import { test } from "node:test";

import { validateBlock } from "#backends/wasm/jit/ir/validate.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrInstruction } from "#backends/wasm/jit/ir/types.js";
import { startAddress, v } from "./helpers.js";

test("validateBlock rejects empty blocks", () => {
  throws(() => validateBlock({ instructions: [] }), /cannot validate empty JIT block/);
});

test("validateBlock rejects source-local operand storage", () => {
  throws(() => validateBlock(jitBlock([
    { op: "get", dst: v(0), source: { kind: "operand", index: 0 } },
    nextOp(0)
  ])), /JIT IR must not contain source-local operand storage/);
});

test("validateBlock rejects source-local address ops", () => {
  throws(() => validateBlock(jitBlock([
    { op: "address", dst: v(0), operand: { kind: "operand", index: 0 } },
    nextOp(0)
  ])), /JIT IR must not contain source-local address operands/);
});

test("validateBlock rejects nextEip value refs", () => {
  throws(() => validateBlock(jitBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: { kind: "nextEip" } },
    nextOp(0)
  ])), /JIT IR must not contain nextEip refs/);
});

test("validateBlock accepts concrete instruction IR bodies", () => {
  validateBlock({
    instructions: [
      jitInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        nextOp(0)
      ]),
      jitInstruction([
        { op: "get", dst: v(1), source: { kind: "reg", reg: "ebx" } },
        nextOp(1)
      ], 1)
    ]
  });
});

test("validateBlock rejects non-final non-fallthrough instructions", () => {
  throws(() => validateBlock({
    instructions: [
      jitInstruction([
        { op: "jump", target: { kind: "const", type: "i32", value: startAddress + 8 } }
      ]),
      jitInstruction([nextOp(1)], 1)
    ]
  }), /non-final JIT instruction must fall through/);
});

test("validateBlock rejects non-final fallthroughs that skip the next instruction", () => {
  throws(() => validateBlock({
    instructions: [
      jitInstruction([nextOp(0)], 0, startAddress + 8),
      jitInstruction([nextOp(1)], 1)
    ]
  }), /non-final JIT instruction fallthrough target 0x1008 does not match next instruction EIP 0x1001/);
});

test("validateBlock allows final exiting instructions", () => {
  validateBlock(jitBlock([
    { op: "jump", target: { kind: "const", type: "i32", value: startAddress + 8 } }
  ]));
});

test("validateBlock rejects ops outside shared x86 IR", () => {
  throws(() => validateBlock(jitBlock([
    { op: "jit.cache" },
    nextOp(0)
  ] as unknown as IrBlock)), /unhandled IR op semantics/);
});

function jitBlock(ir: IrBlock): JitIrBlock {
  return { instructions: [jitInstruction(ir)] };
}

function jitInstruction(
  ir: IrBlock,
  index = 0,
  nextEip = startAddress + index + 1
): JitIrInstruction {
  return {
    instructionId: "synthetic.verifier",
    eip: startAddress + index,
    nextEip,
    ir
  };
}

function nextOp(_index: number): Extract<IrBlock[number], { op: "next" }> {
  return { op: "next" };
}
