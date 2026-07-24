import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { X86_32_CORE } from "#instructions/isa/x86-32.js";

test("x86-32 instruction ids are present and unique", () => {
  const ids = X86_32_CORE.instructions.map((instruction) => instruction.id);

  ok(ids.length > 0);
  strictEqual(new Set(ids).size, ids.length);

  for (const id of ids) {
    ok(id.trim().length > 0);
  }
});

test("registered instructions have a decodable opcode and display text", () => {
  for (const instruction of X86_32_CORE.instructions) {
    ok(instruction.opcode.length > 0, instruction.id);
    ok(instruction.mnemonic.trim().length > 0, instruction.id);
    ok(instruction.syntax.trim().length > 0, instruction.id);
  }
});

test("instruction operands agree with their encoded ordering and opcode fields", () => {
  for (const instruction of X86_32_CORE.instructions) {
    const operands = instruction.operands ?? [];
    const relativeIndex = operands.findIndex(
      (operand) => operand.kind === "rel"
    );
    const hasOpcodeRegister = operands.some(
      (operand) => operand.kind === "opcode.reg"
    );
    const hasOpcodeLowBits = instruction.opcode.some(
      (part) =>
        typeof part !== "number" &&
        (part.bits ?? 8) < 8
    );

    ok(
      relativeIndex === -1 || relativeIndex === operands.length - 1,
      `${instruction.id} relative operand must be last`
    );
    strictEqual(
      hasOpcodeRegister,
      hasOpcodeLowBits,
      `${instruction.id} opcode register binding`
    );
  }
});
