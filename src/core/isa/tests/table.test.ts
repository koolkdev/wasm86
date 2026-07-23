import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { X86_32_CORE } from "#core/index.js";

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
