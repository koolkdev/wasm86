import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeIsaInstructionFromReader } from "#x86/decoder/decode.js";
import { ByteArrayDecodeReader, decodeBytes, imm8, imm32, mem, mem32, ok, reg, reg32, signImm8, startAddress } from "./helpers.js";

test("decodes opcode-encoded register and imm32 operands", () => {
  const decoded = ok(decodeBytes([0xbb, 0x78, 0x56, 0x34, 0x12]));

  strictEqual(decoded.spec.id, "mov.r32_imm32");
  strictEqual(decoded.spec.syntax, "mov {0}, {1}");
  strictEqual(decoded.length, 5);
  strictEqual(decoded.nextEip, startAddress + 5);
  deepStrictEqual(decoded.raw, [0xbb, 0x78, 0x56, 0x34, 0x12]);
  deepStrictEqual(decoded.operands, [reg32("ebx"), imm32(0x1234_5678)]);
});

test("decodes directly from guest memory without requiring a full instruction slice", () => {
  const reader = new ByteArrayDecodeReader([0x90], startAddress);

  const decoded = ok(decodeIsaInstructionFromReader(reader, startAddress));

  strictEqual(decoded.spec.id, "xchg.eax_r32");
  strictEqual(decoded.length, 1);
  deepStrictEqual(decoded.raw, [0x90]);
  deepStrictEqual(decoded.operands, [reg32("eax"), reg32("eax")]);
});

test("decodes multibyte ModRM/SIB instruction directly from guest memory", () => {
  const values = [0x8b, 0x84, 0x88, 0x10, 0x00, 0x00, 0x00];
  const reader = new ByteArrayDecodeReader(values, startAddress);
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
  strictEqual(mov.spec.syntax, "mov {0}, {1}");
  deepStrictEqual(mov.operands, [reg32("eax"), reg32("ebx")]);

  strictEqual(reverse.spec.id, "mov.rm32_r32");
  strictEqual(reverse.spec.syntax, "mov {0}, {1}");
  deepStrictEqual(reverse.operands, [reg32("ebx"), reg32("eax")]);
});

test("decodes xchg ModRM and accumulator forms", () => {
  const dword = ok(decodeBytes([0x87, 0xd8]));
  const byte = ok(decodeBytes([0x86, 0xd8]));
  const word = ok(decodeBytes([0x66, 0x87, 0xd8]));
  const highByte = ok(decodeBytes([0x86, 0xe0]));
  const dwordMem = ok(decodeBytes([0x87, 0x18]));
  const byteMem = ok(decodeBytes([0x86, 0x18]));
  const wordMem = ok(decodeBytes([0x66, 0x87, 0x18]));
  const accumulatorDword = ok(decodeBytes([0x91]));
  const accumulatorWord = ok(decodeBytes([0x66, 0x93]));
  const accumulatorWordSelf = ok(decodeBytes([0x66, 0x90]));

  strictEqual(dword.spec.id, "xchg.rm32_r32");
  strictEqual(dword.spec.syntax, "xchg {0}, {1}");
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

  strictEqual(accumulatorDword.spec.id, "xchg.eax_r32");
  deepStrictEqual(accumulatorDword.operands, [reg32("eax"), reg32("ecx")]);

  strictEqual(accumulatorWord.spec.id, "xchg.ax_r16");
  deepStrictEqual(accumulatorWord.operands, [reg("ax"), reg("bx")]);

  strictEqual(accumulatorWordSelf.spec.id, "xchg.ax_r16");
  deepStrictEqual(accumulatorWordSelf.operands, [reg("ax"), reg("ax")]);
});

test("uses ModRM match fields for slash-digit groups", () => {
  // 83 /5 ib: SUB r/m32, sign-extended imm8
  const sub = ok(decodeBytes([0x83, 0xeb, 0xff]));
  // 83 /1 ib: OR r/m32, sign-extended imm8
  const or = ok(decodeBytes([0x83, 0xcb, 0x7f]));
  // 83 /2 ib: ADC r/m32, sign-extended imm8
  const adc = ok(decodeBytes([0x83, 0xd3, 0xff]));
  // 83 /3 ib: SBB r/m32, sign-extended imm8
  const sbb = ok(decodeBytes([0x83, 0xdb, 0x80]));
  // 81 /4 id: AND r/m32, imm32
  const and = ok(decodeBytes([0x81, 0xe3, 0x78, 0x56, 0x34, 0x12]));
  // 81 /6 id: XOR r/m32, imm32
  const xor = ok(decodeBytes([0x81, 0xf3, 0x78, 0x56, 0x34, 0x12]));

  strictEqual(sub.spec.id, "sub.rm32_imm8");
  strictEqual(sub.spec.syntax, "sub {0}, {1}");
  deepStrictEqual(sub.operands, [reg32("ebx"), signImm8(0xffff_ffff)]);

  strictEqual(or.spec.id, "or.rm32_imm8");
  strictEqual(or.spec.syntax, "or {0}, {1}");
  deepStrictEqual(or.operands, [reg32("ebx"), signImm8(0x7f)]);

  strictEqual(adc.spec.id, "adc.rm32_imm8");
  strictEqual(adc.spec.syntax, "adc {0}, {1}");
  deepStrictEqual(adc.operands, [reg32("ebx"), signImm8(0xffff_ffff)]);

  strictEqual(sbb.spec.id, "sbb.rm32_imm8");
  strictEqual(sbb.spec.syntax, "sbb {0}, {1}");
  deepStrictEqual(sbb.operands, [reg32("ebx"), signImm8(0xffff_ff80)]);

  strictEqual(and.spec.id, "and.rm32_imm32");
  strictEqual(and.spec.syntax, "and {0}, {1}");
  deepStrictEqual(and.operands, [reg32("ebx"), imm32(0x1234_5678)]);

  strictEqual(xor.spec.id, "xor.rm32_imm32");
  strictEqual(xor.spec.syntax, "xor {0}, {1}");
  deepStrictEqual(xor.operands, [reg32("ebx"), imm32(0x1234_5678)]);
});

test("rejects unregistered grouped opcodes after ModRM.reg dispatch", () => {
  // F7 /1 remains unregistered in the current ISA subset.
  const decoded = decodeBytes([0xf7, 0xc8]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 2);
    deepStrictEqual(decoded.raw, [0xf7, 0xc8]);
    strictEqual(decoded.unsupportedByte, 0xf7);
  }
});

test("cmpxchg8b register ModRM form is unsupported", () => {
  const decoded = decodeBytes([0x0f, 0xc7, 0xc8]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 3);
    deepStrictEqual(decoded.raw, [0x0f, 0xc7, 0xc8]);
    strictEqual(decoded.unsupportedByte, 0x0f);
  }
});

test("decodes direct relative targets as absolute target operands", () => {
  const jmp8 = ok(decodeBytes([0xeb, 0xfe]));
  const jmp16 = ok(decodeBytes([0x66, 0xe9, 0xfc, 0xff]));
  const jmp16Wrap = ok(decodeBytes([0x66, 0xe9, 0x02, 0x00], 0xfffe));
  const jmp32 = ok(decodeBytes([0xe9, 0xfb, 0xff, 0xff, 0xff]));

  strictEqual(jmp8.spec.id, "jmp.rel8");
  strictEqual(jmp8.spec.syntax, "jmp {0}");
  strictEqual(jmp8.nextEip, startAddress + 2);
  deepStrictEqual(jmp8.operands, [
    { kind: "relTarget", width: 8, displacement: -2, target: startAddress }
  ]);

  strictEqual(jmp16.spec.id, "jmp.rel16");
  strictEqual(jmp16.spec.syntax, "jmp {0}");
  strictEqual(jmp16.nextEip, startAddress + 4);
  deepStrictEqual(jmp16.operands, [
    { kind: "relTarget", width: 16, displacement: -4, target: startAddress }
  ]);

  strictEqual(jmp16Wrap.spec.id, "jmp.rel16");
  deepStrictEqual(jmp16Wrap.operands, [
    { kind: "relTarget", width: 16, displacement: 2, target: 0x0004 }
  ]);

  strictEqual(jmp32.spec.id, "jmp.rel32");
  strictEqual(jmp32.spec.syntax, "jmp {0}");
  strictEqual(jmp32.nextEip, startAddress + 5);
  deepStrictEqual(jmp32.operands, [
    { kind: "relTarget", width: 32, displacement: -5, target: startAddress }
  ]);
});

test("decodes concrete jcc rel8, rel16, and rel32 forms", () => {
  const rel8 = ok(decodeBytes([0x75, 0x05]));
  const rel16 = ok(decodeBytes([0x66, 0x0f, 0x85, 0xfa, 0xff]));
  const rel16Wrap = ok(decodeBytes([0x66, 0x0f, 0x84, 0x02, 0x00], 0xfffc));
  const rel32 = ok(decodeBytes([0x0f, 0x85, 0xfa, 0xff, 0xff, 0xff]));

  strictEqual(rel8.spec.id, "jne.rel8");
  strictEqual(rel8.spec.syntax, "jne {0}");
  deepStrictEqual(rel8.operands, [
    { kind: "relTarget", width: 8, displacement: 5, target: startAddress + 7 }
  ]);

  strictEqual(rel16.spec.id, "jne.rel16");
  strictEqual(rel16.spec.syntax, "jne {0}");
  deepStrictEqual(rel16.operands, [
    { kind: "relTarget", width: 16, displacement: -6, target: startAddress - 1 }
  ]);

  strictEqual(rel16Wrap.spec.id, "je.rel16");
  deepStrictEqual(rel16Wrap.operands, [
    { kind: "relTarget", width: 16, displacement: 2, target: 0x0003 }
  ]);

  strictEqual(rel32.spec.id, "jne.rel32");
  strictEqual(rel32.spec.syntax, "jne {0}");
  deepStrictEqual(rel32.operands, [
    { kind: "relTarget", width: 32, displacement: -6, target: startAddress }
  ]);
});

test("decodes multi-byte nop and int imm8 forms", () => {
  const multiByteNop = ok(decodeBytes([0x0f, 0x1f, 0x40, 0x00]));
  const wordNop = ok(decodeBytes([0x66, 0x0f, 0x1f, 0x00]));
  const trap = ok(decodeBytes([0xcd, 0x2e]));

  strictEqual(multiByteNop.spec.id, "nop.rm32");
  strictEqual(multiByteNop.spec.syntax, "nop {0}");
  strictEqual(multiByteNop.length, 4);
  deepStrictEqual(multiByteNop.operands, [mem32({ base: "eax", scale: 1, disp: 0 })]);

  strictEqual(wordNop.spec.id, "nop.rm16");
  strictEqual(wordNop.spec.syntax, "nop {0}");
  strictEqual(wordNop.length, 4);
  deepStrictEqual(wordNop.operands, [mem(16, { base: "eax", scale: 1, disp: 0 })]);

  strictEqual(trap.spec.id, "int.imm8");
  strictEqual(trap.spec.syntax, "int {0}");
  strictEqual(trap.length, 2);
  deepStrictEqual(trap.operands, [imm8(0x2e)]);
});

test("decodes ModRM memory operands with displacement", () => {
  // 8B 43 04: MOV eax, [ebx + 4]
  const decoded = ok(decodeBytes([0x8b, 0x43, 0x04]));

  strictEqual(decoded.spec.id, "mov.r32_rm32");
  strictEqual(decoded.spec.syntax, "mov {0}, {1}");
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
