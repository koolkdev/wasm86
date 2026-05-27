import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { GuestMemoryDecodeReader } from "#x86/decoder/guest-memory-reader.js";
import { decodeIsaInstructionFromReader } from "#x86/decoder/decode.js";
import { decodeBytes, imm8, imm32, mem, mem32, ok, reg, reg32, signImm8, startAddress } from "./helpers.js";

test("decodes opcode-encoded register and imm32 operands", () => {
  const decoded = ok(decodeBytes([0xbb, 0x78, 0x56, 0x34, 0x12]));

  strictEqual(decoded.spec.id, "mov.r32_imm32");
  strictEqual(decoded.spec.format.syntax, "mov {0}, {1}");
  strictEqual(decoded.length, 5);
  strictEqual(decoded.nextEip, startAddress + 5);
  deepStrictEqual(decoded.raw, [0xbb, 0x78, 0x56, 0x34, 0x12]);
  deepStrictEqual(decoded.operands, [reg32("ebx"), imm32(0x1234_5678)]);
});

test("decodes directly from guest memory without requiring a full instruction slice", () => {
  const memory = new ArrayBufferGuestMemory(startAddress + 1);
  memory.writeU8(startAddress, 0x90);
  const reader = new GuestMemoryDecodeReader(memory, [
    { kind: "guest-memory", baseAddress: startAddress, byteLength: 1 }
  ]);

  const decoded = ok(decodeIsaInstructionFromReader(reader, startAddress));

  strictEqual(decoded.spec.id, "nop.near");
  strictEqual(decoded.length, 1);
  deepStrictEqual(decoded.raw, [0x90]);
});

test("decodes multibyte ModRM/SIB instruction directly from guest memory", () => {
  const memory = new ArrayBufferGuestMemory(startAddress + 7);
  const values = [0x8b, 0x84, 0x88, 0x10, 0x00, 0x00, 0x00];

  for (let index = 0; index < values.length; index += 1) {
    memory.writeU8(startAddress + index, values[index] ?? 0);
  }

  const reader = new GuestMemoryDecodeReader(memory, [
    { kind: "guest-memory", baseAddress: startAddress, byteLength: values.length }
  ]);
  const decoded = ok(decodeIsaInstructionFromReader(reader, startAddress));

  strictEqual(decoded.spec.id, "mov.r32_rm32");
  strictEqual(decoded.length, 7);
  deepStrictEqual(decoded.raw, values);
  deepStrictEqual(decoded.operands, [
    reg32("eax"),
    mem32({ base: "eax", index: "ecx", scale: 4, disp: 0x10 })
  ]);
});

test("decodes slash-r register/register operands positionally", () => {
  // 8B C3: MOV eax, ebx
  const mov = ok(decodeBytes([0x8b, 0xc3]));
  // 89 C3: MOV ebx, eax
  const reverse = ok(decodeBytes([0x89, 0xc3]));

  strictEqual(mov.spec.id, "mov.r32_rm32");
  strictEqual(mov.spec.format.syntax, "mov {0}, {1}");
  deepStrictEqual(mov.operands, [reg32("eax"), reg32("ebx")]);

  strictEqual(reverse.spec.id, "mov.rm32_r32");
  strictEqual(reverse.spec.format.syntax, "mov {0}, {1}");
  deepStrictEqual(reverse.operands, [reg32("ebx"), reg32("eax")]);
});

test("decodes xchg ModRM register and memory forms", () => {
  const dword = ok(decodeBytes([0x87, 0xd8]));
  const byte = ok(decodeBytes([0x86, 0xd8]));
  const word = ok(decodeBytes([0x66, 0x87, 0xd8]));
  const highByte = ok(decodeBytes([0x86, 0xe0]));
  const dwordMem = ok(decodeBytes([0x87, 0x18]));
  const byteMem = ok(decodeBytes([0x86, 0x18]));
  const wordMem = ok(decodeBytes([0x66, 0x87, 0x18]));

  strictEqual(dword.spec.id, "xchg.rm32_r32");
  strictEqual(dword.spec.format.syntax, "xchg {0}, {1}");
  deepStrictEqual(dword.operands, [reg32("eax"), reg32("ebx")]);

  strictEqual(byte.spec.id, "xchg.rm8_r8");
  deepStrictEqual(byte.operands, [reg("al"), reg("bl")]);

  strictEqual(word.spec.id, "xchg.rm16_r16");
  deepStrictEqual(word.operands, [reg("ax"), reg("bx")]);

  strictEqual(highByte.spec.id, "xchg.rm8_r8");
  deepStrictEqual(highByte.operands, [reg("al"), reg("ah")]);

  strictEqual(dwordMem.spec.id, "xchg.rm32_r32");
  deepStrictEqual(dwordMem.operands, [mem32({ base: "eax", scale: 1, disp: 0 }), reg32("ebx")]);

  strictEqual(byteMem.spec.id, "xchg.rm8_r8");
  deepStrictEqual(byteMem.operands, [mem(8, { base: "eax", scale: 1, disp: 0 }), reg("bl")]);

  strictEqual(wordMem.spec.id, "xchg.rm16_r16");
  deepStrictEqual(wordMem.operands, [mem(16, { base: "eax", scale: 1, disp: 0 }), reg("bx")]);
});

test("uses ModRM match fields for slash-digit groups", () => {
  // 83 /5 ib: SUB r/m32, sign-extended imm8
  const sub = ok(decodeBytes([0x83, 0xeb, 0xff]));
  // 83 /1 ib: OR r/m32, sign-extended imm8
  const or = ok(decodeBytes([0x83, 0xcb, 0x7f]));
  // 81 /4 id: AND r/m32, imm32
  const and = ok(decodeBytes([0x81, 0xe3, 0x78, 0x56, 0x34, 0x12]));
  // 81 /6 id: XOR r/m32, imm32
  const xor = ok(decodeBytes([0x81, 0xf3, 0x78, 0x56, 0x34, 0x12]));

  strictEqual(sub.spec.id, "sub.rm32_imm8");
  strictEqual(sub.spec.format.syntax, "sub {0}, {1}");
  deepStrictEqual(sub.operands, [reg32("ebx"), signImm8(0xffff_ffff)]);

  strictEqual(or.spec.id, "or.rm32_imm8");
  strictEqual(or.spec.format.syntax, "or {0}, {1}");
  deepStrictEqual(or.operands, [reg32("ebx"), signImm8(0x7f)]);

  strictEqual(and.spec.id, "and.rm32_imm32");
  strictEqual(and.spec.format.syntax, "and {0}, {1}");
  deepStrictEqual(and.operands, [reg32("ebx"), imm32(0x1234_5678)]);

  strictEqual(xor.spec.id, "xor.rm32_imm32");
  strictEqual(xor.spec.format.syntax, "xor {0}, {1}");
  deepStrictEqual(xor.operands, [reg32("ebx"), imm32(0x1234_5678)]);
});

test("rejects unregistered grouped opcodes after ModRM.reg dispatch", () => {
  // 83 /2 ib is not registered in the current ISA subset.
  const decoded = decodeBytes([0x83, 0xd0, 0x01]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 2);
    deepStrictEqual(decoded.raw, [0x83, 0xd0]);
    strictEqual(decoded.unsupportedByte, 0x83);
  }
});

test("decodes direct relative targets as absolute target operands", () => {
  const jmp8 = ok(decodeBytes([0xeb, 0xfe]));
  const jmp32 = ok(decodeBytes([0xe9, 0xfb, 0xff, 0xff, 0xff]));

  strictEqual(jmp8.spec.id, "jmp.rel8");
  strictEqual(jmp8.spec.format.syntax, "jmp {0}");
  strictEqual(jmp8.nextEip, startAddress + 2);
  deepStrictEqual(jmp8.operands, [
    { kind: "relTarget", width: 8, displacement: -2, target: startAddress }
  ]);

  strictEqual(jmp32.spec.id, "jmp.rel32");
  strictEqual(jmp32.spec.format.syntax, "jmp {0}");
  strictEqual(jmp32.nextEip, startAddress + 5);
  deepStrictEqual(jmp32.operands, [
    { kind: "relTarget", width: 32, displacement: -5, target: startAddress }
  ]);
});

test("decodes concrete jcc rel8 and rel32 forms", () => {
  const rel8 = ok(decodeBytes([0x75, 0x05]));
  const rel32 = ok(decodeBytes([0x0f, 0x85, 0xfa, 0xff, 0xff, 0xff]));

  strictEqual(rel8.spec.id, "jne.rel8");
  strictEqual(rel8.spec.format.syntax, "jne {0}");
  deepStrictEqual(rel8.operands, [
    { kind: "relTarget", width: 8, displacement: 5, target: startAddress + 7 }
  ]);

  strictEqual(rel32.spec.id, "jne.rel32");
  strictEqual(rel32.spec.format.syntax, "jne {0}");
  deepStrictEqual(rel32.operands, [
    { kind: "relTarget", width: 32, displacement: -6, target: startAddress }
  ]);
});

test("decodes nop and int imm8 forms", () => {
  const nop = ok(decodeBytes([0x90]));
  const multiByteNop = ok(decodeBytes([0x0f, 0x1f, 0x40, 0x00]));
  const wordNop = ok(decodeBytes([0x66, 0x0f, 0x1f, 0x00]));
  const trap = ok(decodeBytes([0xcd, 0x2e]));

  strictEqual(nop.spec.id, "nop.near");
  strictEqual(nop.spec.format.syntax, "nop");
  strictEqual(nop.length, 1);
  deepStrictEqual(nop.operands, []);

  strictEqual(multiByteNop.spec.id, "nop.rm32");
  strictEqual(multiByteNop.spec.format.syntax, "nop {0}");
  strictEqual(multiByteNop.length, 4);
  deepStrictEqual(multiByteNop.operands, [mem32({ base: "eax", scale: 1, disp: 0 })]);

  strictEqual(wordNop.spec.id, "nop.rm16");
  strictEqual(wordNop.spec.format.syntax, "nop {0}");
  strictEqual(wordNop.length, 4);
  deepStrictEqual(wordNop.operands, [mem(16, { base: "eax", scale: 1, disp: 0 })]);

  strictEqual(trap.spec.id, "int.imm8");
  strictEqual(trap.spec.format.syntax, "int {0}");
  strictEqual(trap.length, 2);
  deepStrictEqual(trap.operands, [imm8(0x2e)]);
});

test("decodes ModRM memory operands with displacement", () => {
  // 8B 43 04: MOV eax, [ebx + 4]
  const decoded = ok(decodeBytes([0x8b, 0x43, 0x04]));

  strictEqual(decoded.spec.id, "mov.r32_rm32");
  strictEqual(decoded.spec.format.syntax, "mov {0}, {1}");
  deepStrictEqual(decoded.operands, [reg32("eax"), mem32({ base: "ebx", scale: 1, disp: 4 })]);
});

test("rejects address-only m32 forms when ModRM encodes a register", () => {
  // 8D C3: LEA eax, ebx is invalid because LEA requires memory/address form.
  const decoded = decodeBytes([0x8d, 0xc3]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 2);
    deepStrictEqual(decoded.raw, [0x8d, 0xc3]);
    strictEqual(decoded.unsupportedByte, 0x8d);
  }
});

test("reports unsupported opcode bytes", () => {
  const decoded = decodeBytes([0x62]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 1);
    deepStrictEqual(decoded.raw, [0x62]);
    strictEqual(decoded.unsupportedByte, 0x62);
  }
});
