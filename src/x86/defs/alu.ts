import { form, mnemonic } from "#x86/schema/builders.js";
import { opcodePlusReg } from "#x86/schema/opcodes.js";
import { imm, implicitReg, modrmReg, modrmRm, opReg } from "#x86/schema/operands.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";

export const ADD = mnemonic("add", [
  // 00 /r: ADD r/m8, r8
  form("rm8_r8", {
    opcode: [0x00],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 8)
  }),
  // 02 /r: ADD r8, r/m8
  form("r8_rm8", {
    opcode: [0x02],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 8)
  }),
  // 04 ib: ADD AL, imm8
  form("al_imm8", {
    opcode: [0x04],
    operands: [implicitReg("al"), imm(8)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 8)
  }),
  // 80 /0 ib: ADD r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 8)
  }),
  // 66 01 /r: ADD r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x01],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 16)
  }),
  // 66 03 /r: ADD r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x03],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 16)
  }),
  // 01 /r: ADD r/m32, r32
  form("rm32_r32", {
    opcode: [0x01],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 32)
  }),
  // 03 /r: ADD r32, r/m32
  form("r32_rm32", {
    opcode: [0x03],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 32)
  }),
  // 05 id: ADD EAX, imm32
  form("eax_imm32", {
    opcode: [0x05],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 32)
  }),
  // 66 05 iw: ADD AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x05],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 16)
  }),
  // 66 81 /0 iw: ADD r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 16)
  }),
  // 81 /0 id: ADD r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 32)
  }),
  // 66 83 /0 ib: ADD r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 16)
  }),
  // 83 /0 ib: ADD r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "add {0}, {1}",
    semantics: aluSemantic("add", 32)
  })
]);

export const ADC = mnemonic("adc", [
  // 10 /r: ADC r/m8, r8
  form("rm8_r8", {
    opcode: [0x10],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 8)
  }),
  // 12 /r: ADC r8, r/m8
  form("r8_rm8", {
    opcode: [0x12],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 8)
  }),
  // 14 ib: ADC AL, imm8
  form("al_imm8", {
    opcode: [0x14],
    operands: [implicitReg("al"), imm(8)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 8)
  }),
  // 80 /2 ib: ADC r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 8)
  }),
  // 66 11 /r: ADC r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x11],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 16)
  }),
  // 66 13 /r: ADC r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x13],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 16)
  }),
  // 11 /r: ADC r/m32, r32
  form("rm32_r32", {
    opcode: [0x11],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 32)
  }),
  // 13 /r: ADC r32, r/m32
  form("r32_rm32", {
    opcode: [0x13],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 32)
  }),
  // 15 id: ADC EAX, imm32
  form("eax_imm32", {
    opcode: [0x15],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 32)
  }),
  // 66 15 iw: ADC AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x15],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 16)
  }),
  // 66 81 /2 iw: ADC r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 16)
  }),
  // 81 /2 id: ADC r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 32)
  }),
  // 66 83 /2 ib: ADC r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 16)
  }),
  // 83 /2 ib: ADC r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "adc {0}, {1}",
    semantics: aluSemantic("adc", 32)
  })
]);

export const OR = mnemonic("or", [
  // 08 /r: OR r/m8, r8
  form("rm8_r8", {
    opcode: [0x08],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 8)
  }),
  // 0A /r: OR r8, r/m8
  form("r8_rm8", {
    opcode: [0x0a],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 8)
  }),
  // 0C ib: OR AL, imm8
  form("al_imm8", {
    opcode: [0x0c],
    operands: [implicitReg("al"), imm(8)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 8)
  }),
  // 80 /1 ib: OR r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 8)
  }),
  // 66 09 /r: OR r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x09],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 16)
  }),
  // 66 0B /r: OR r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 16)
  }),
  // 09 /r: OR r/m32, r32
  form("rm32_r32", {
    opcode: [0x09],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 32)
  }),
  // 0B /r: OR r32, r/m32
  form("r32_rm32", {
    opcode: [0x0b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 32)
  }),
  // 0D id: OR EAX, imm32
  form("eax_imm32", {
    opcode: [0x0d],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 32)
  }),
  // 66 0D iw: OR AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0d],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 16)
  }),
  // 66 81 /1 iw: OR r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 16)
  }),
  // 81 /1 id: OR r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 32)
  }),
  // 66 83 /1 ib: OR r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 16)
  }),
  // 83 /1 ib: OR r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "or {0}, {1}",
    semantics: aluSemantic("or", 32)
  })
]);

export const SBB = mnemonic("sbb", [
  // 18 /r: SBB r/m8, r8
  form("rm8_r8", {
    opcode: [0x18],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 8)
  }),
  // 1A /r: SBB r8, r/m8
  form("r8_rm8", {
    opcode: [0x1a],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 8)
  }),
  // 1C ib: SBB AL, imm8
  form("al_imm8", {
    opcode: [0x1c],
    operands: [implicitReg("al"), imm(8)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 8)
  }),
  // 80 /3 ib: SBB r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 8)
  }),
  // 66 19 /r: SBB r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x19],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 16)
  }),
  // 66 1B /r: SBB r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x1b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 16)
  }),
  // 19 /r: SBB r/m32, r32
  form("rm32_r32", {
    opcode: [0x19],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 32)
  }),
  // 1B /r: SBB r32, r/m32
  form("r32_rm32", {
    opcode: [0x1b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 32)
  }),
  // 1D id: SBB EAX, imm32
  form("eax_imm32", {
    opcode: [0x1d],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 32)
  }),
  // 66 1D iw: SBB AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x1d],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 16)
  }),
  // 66 81 /3 iw: SBB r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 16)
  }),
  // 81 /3 id: SBB r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 32)
  }),
  // 66 83 /3 ib: SBB r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 16)
  }),
  // 83 /3 ib: SBB r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "sbb {0}, {1}",
    semantics: aluSemantic("sbb", 32)
  })
]);

export const AND = mnemonic("and", [
  // 20 /r: AND r/m8, r8
  form("rm8_r8", {
    opcode: [0x20],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 8)
  }),
  // 22 /r: AND r8, r/m8
  form("r8_rm8", {
    opcode: [0x22],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 8)
  }),
  // 24 ib: AND AL, imm8
  form("al_imm8", {
    opcode: [0x24],
    operands: [implicitReg("al"), imm(8)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 8)
  }),
  // 80 /4 ib: AND r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 8)
  }),
  // 66 21 /r: AND r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x21],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 16)
  }),
  // 66 23 /r: AND r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x23],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 16)
  }),
  // 21 /r: AND r/m32, r32
  form("rm32_r32", {
    opcode: [0x21],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 32)
  }),
  // 23 /r: AND r32, r/m32
  form("r32_rm32", {
    opcode: [0x23],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 32)
  }),
  // 25 id: AND EAX, imm32
  form("eax_imm32", {
    opcode: [0x25],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 32)
  }),
  // 66 25 iw: AND AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x25],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 16)
  }),
  // 66 81 /4 iw: AND r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 16)
  }),
  // 81 /4 id: AND r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 32)
  }),
  // 66 83 /4 ib: AND r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 16)
  }),
  // 83 /4 ib: AND r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "and {0}, {1}",
    semantics: aluSemantic("and", 32)
  })
]);

export const SUB = mnemonic("sub", [
  // 28 /r: SUB r/m8, r8
  form("rm8_r8", {
    opcode: [0x28],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 8)
  }),
  // 2A /r: SUB r8, r/m8
  form("r8_rm8", {
    opcode: [0x2a],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 8)
  }),
  // 2C ib: SUB AL, imm8
  form("al_imm8", {
    opcode: [0x2c],
    operands: [implicitReg("al"), imm(8)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 8)
  }),
  // 80 /5 ib: SUB r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 8)
  }),
  // 66 29 /r: SUB r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x29],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 16)
  }),
  // 66 2B /r: SUB r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x2b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 16)
  }),
  // 29 /r: SUB r/m32, r32
  form("rm32_r32", {
    opcode: [0x29],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 32)
  }),
  // 2B /r: SUB r32, r/m32
  form("r32_rm32", {
    opcode: [0x2b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 32)
  }),
  // 2D id: SUB EAX, imm32
  form("eax_imm32", {
    opcode: [0x2d],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 32)
  }),
  // 66 2D iw: SUB AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x2d],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 16)
  }),
  // 66 81 /5 iw: SUB r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 16)
  }),
  // 81 /5 id: SUB r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 32)
  }),
  // 66 83 /5 ib: SUB r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 16)
  }),
  // 83 /5 ib: SUB r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "sub {0}, {1}",
    semantics: aluSemantic("sub", 32)
  })
]);

export const XOR = mnemonic("xor", [
  // 30 /r: XOR r/m8, r8
  form("rm8_r8", {
    opcode: [0x30],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 8)
  }),
  // 32 /r: XOR r8, r/m8
  form("r8_rm8", {
    opcode: [0x32],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 8)
  }),
  // 34 ib: XOR AL, imm8
  form("al_imm8", {
    opcode: [0x34],
    operands: [implicitReg("al"), imm(8)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 8)
  }),
  // 80 /6 ib: XOR r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 8)
  }),
  // 66 31 /r: XOR r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x31],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 16)
  }),
  // 66 33 /r: XOR r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x33],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 16)
  }),
  // 31 /r: XOR r/m32, r32
  form("rm32_r32", {
    opcode: [0x31],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 32)
  }),
  // 33 /r: XOR r32, r/m32
  form("r32_rm32", {
    opcode: [0x33],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 32)
  }),
  // 35 id: XOR EAX, imm32
  form("eax_imm32", {
    opcode: [0x35],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 32)
  }),
  // 66 35 iw: XOR AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x35],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 16)
  }),
  // 66 81 /6 iw: XOR r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 16)
  }),
  // 81 /6 id: XOR r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 32)
  }),
  // 66 83 /6 ib: XOR r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 16)
  }),
  // 83 /6 ib: XOR r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "xor {0}, {1}",
    semantics: aluSemantic("xor", 32)
  })
]);

export const INC = mnemonic("inc", [
  // FE /0: INC r/m8
  form("rm8", {
    opcode: [0xfe],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm8")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 8)
  }),
  // 66 40+rw: INC r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x40)],
    operands: [opReg("r16")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 16)
  }),
  // 40+rd: INC r32
  form("r32", {
    opcode: [opcodePlusReg(0x40)],
    operands: [opReg()],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 32)
  }),
  // 66 FF /0: INC r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 16)
  }),
  // FF /0: INC r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32")],
    syntax: "inc {0}",
    semantics: unaryAluSemantic("inc", 32)
  })
]);

export const DEC = mnemonic("dec", [
  // FE /1: DEC r/m8
  form("rm8", {
    opcode: [0xfe],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm8")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 8)
  }),
  // 66 48+rw: DEC r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x48)],
    operands: [opReg("r16")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 16)
  }),
  // 48+rd: DEC r32
  form("r32", {
    opcode: [opcodePlusReg(0x48)],
    operands: [opReg()],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 32)
  }),
  // 66 FF /1: DEC r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm16")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 16)
  }),
  // FF /1: DEC r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("rm32")],
    syntax: "dec {0}",
    semantics: unaryAluSemantic("dec", 32)
  })
]);

export const NOT = mnemonic("not", [
  // F6 /2: NOT r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm8")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 8)
  }),
  // 66 F7 /2: NOT r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm16")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 16)
  }),
  // F7 /2: NOT r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 2 } },
    operands: [modrmRm("rm32")],
    syntax: "not {0}",
    semantics: unaryAluSemantic("not", 32)
  })
]);

export const NEG = mnemonic("neg", [
  // F6 /3: NEG r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm8")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 8)
  }),
  // 66 F7 /3: NEG r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm16")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 16)
  }),
  // F7 /3: NEG r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 3 } },
    operands: [modrmRm("rm32")],
    syntax: "neg {0}",
    semantics: unaryAluSemantic("neg", 32)
  })
]);
