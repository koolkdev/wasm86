import { strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import { formatIsaInstruction, formatIsaOperand } from "#x86/format.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";

test("formats register and immediate operands through instruction format metadata", () => {
  const decoded = decode([0xbb, 0x78, 0x56, 0x34, 0x12]);

  strictEqual(formatIsaInstruction(decoded), "mov ebx, 0x12345678");
});

test("formats ModRM register operands positionally", () => {
  strictEqual(formatIsaInstruction(decode([0x8b, 0xc3])), "mov eax, ebx");
  strictEqual(formatIsaInstruction(decode([0x89, 0xc3])), "mov ebx, eax");
});

test("formats segment register operands", () => {
  strictEqual(formatIsaInstruction(decode([0x8c, 0xe0])), "mov eax, fs");
  strictEqual(formatIsaInstruction(decode([0x0f, 0xa0])), "push fs");
});

test("formats relative targets as absolute addresses", () => {
  strictEqual(formatIsaInstruction(decode([0xeb, 0xfe])), "jmp 0x1000");
  strictEqual(formatIsaInstruction(decode([0x75, 0x05])), "jne 0x1007");
});

test("formats basic memory operands", () => {
  strictEqual(formatIsaInstruction(decode([0x8b, 0x43, 0x04])), "mov eax, [ebx + 0x4]");
  strictEqual(formatIsaInstruction(decode([0x8b, 0x04, 0x8d, 0x78, 0x56, 0x34, 0x12])), "mov eax, [ecx*4 + 0x12345678]");
  strictEqual(formatIsaInstruction(decode([0xa1, 0x78, 0x56, 0x34, 0x12])), "mov eax, [0x12345678]");
});

test("formats only non-default memory segments explicitly", () => {
  strictEqual(
    formatIsaOperand({
      kind: "mem",
      accessWidth: 32,
      segment: "ss",
      base: "ebp",
      index: undefined,
      scale: 1,
      disp: 0
    }),
    "[ebp]"
  );
  strictEqual(
    formatIsaOperand({
      kind: "mem",
      accessWidth: 32,
      segment: "fs",
      base: "ebx",
      index: undefined,
      scale: 1,
      disp: 0
    }),
    "fs:[ebx]"
  );
});

test("formats unsigned and sign-extended immediates as semantic values", () => {
  strictEqual(formatIsaInstruction(decode([0x83, 0xeb, 0xff])), "sub ebx, 0xffffffff");
  strictEqual(formatIsaInstruction(decode([0xc2, 0x10, 0x00])), "ret 0x10");
});

function decode(values: readonly number[]): IsaDecodedInstruction {
  const result = decodeBytes(values);

  return ok(result);
}
