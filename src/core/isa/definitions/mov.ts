import { CONDITION_CODE_DESCRIPTORS } from "#core/isa/condition-codes.js";
import {
  form,
  imm,
  implicitReg,
  mnemonic,
  modrmReg,
  modrmRm,
  modrmSreg,
  moffs,
  opcodePlusReg,
  opReg
} from "../dsl.js";
import {
  cmovSemantic,
  movSemantic,
  movSregSemantic,
  movsxSemantic,
  movToSregSemantic,
  movzxSemantic
} from "#core/semantics/mov.js";

export const MOV = mnemonic("mov", [
  // 8A /r: MOV r8, r/m8
  form("r8_rm8", {
    opcode: [0x8a],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 88 /r: MOV r/m8, r8
  form("rm8_r8", {
    opcode: [0x88],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 66 8B /r: MOV r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x8b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // 66 89 /r: MOV r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x89],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // 66 8C /r: MOV r/m16, Sreg
  form("rm16_sreg", {
    prefixes: { operandSize: "override" },
    opcode: [0x8c],
    operands: [modrmRm("rm16"), modrmSreg()],
    syntax: "mov {0}, {1}",
    semantics: movSregSemantic(16)
  }),
  // 8B /r: MOV r32, r/m32
  form("r32_rm32", {
    opcode: [0x8b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  }),
  // 89 /r: MOV r/m32, r32
  form("rm32_r32", {
    opcode: [0x89],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  }),
  // 8C /r: MOV r/m32, Sreg
  form("rm32_sreg", {
    opcode: [0x8c],
    operands: [modrmRm("r32_m16"), modrmSreg()],
    syntax: "mov {0}, {1}",
    semantics: movSregSemantic(32)
  }),
  // 66 8E /r: MOV Sreg, r/m16
  form("sreg_rm16_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x8e],
    operands: [modrmSreg(), modrmRm("rm16")],
    syntax: "mov {0}, {1}",
    semantics: movToSregSemantic()
  }),
  // 8E /r: MOV Sreg, r/m16
  form("sreg_rm16", {
    opcode: [0x8e],
    operands: [modrmSreg(), modrmRm("rm16")],
    syntax: "mov {0}, {1}",
    semantics: movToSregSemantic()
  }),
  // A0: MOV AL, moffs8
  form("al_moffs8", {
    opcode: [0xa0],
    operands: [implicitReg("al"), moffs(8)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 66 A1: MOV AX, moffs16
  form("ax_moffs16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa1],
    operands: [implicitReg("ax"), moffs(16)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // A1: MOV EAX, moffs32
  form("eax_moffs32", {
    opcode: [0xa1],
    operands: [implicitReg("eax"), moffs(32)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  }),
  // A2: MOV moffs8, AL
  form("moffs8_al", {
    opcode: [0xa2],
    operands: [moffs(8), implicitReg("al")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 66 A3: MOV moffs16, AX
  form("moffs16_ax", {
    prefixes: { operandSize: "override" },
    opcode: [0xa3],
    operands: [moffs(16), implicitReg("ax")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // A3: MOV moffs32, EAX
  form("moffs32_eax", {
    opcode: [0xa3],
    operands: [moffs(32), implicitReg("eax")],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  }),
  // C6 /0 ib: MOV r/m8, imm8
  form("rm8_imm8", {
    opcode: [0xc6],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 66 C7 /0 iw: MOV r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xc7],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // C7 /0 id: MOV r/m32, imm32
  form("rm32_imm32", {
    opcode: [0xc7],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  }),
  // B0+rb ib: MOV r8, imm8
  form("r8_imm8", {
    opcode: [opcodePlusReg(0xb0)],
    operands: [opReg("r8"), imm(8)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(8)
  }),
  // 66 B8+rw iw: MOV r16, imm16
  form("r16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0xb8)],
    operands: [opReg("r16"), imm(16)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(16)
  }),
  // B8+rd id: MOV r32, imm32
  form("r32_imm32", {
    opcode: [opcodePlusReg(0xb8)],
    operands: [opReg(), imm(32)],
    syntax: "mov {0}, {1}",
    semantics: movSemantic(32)
  })
]);

export const CMOVCC = CONDITION_CODE_DESCRIPTORS.map((descriptor) =>
  mnemonic(`cmov${descriptor.suffix}`, [
    // 66 0F 40+cc /r: CMOVcc r16, r/m16
    form("r16_rm16", {
      prefixes: { operandSize: "override" },
      opcode: [0x0f, 0x40 + descriptor.opcodeLow],
      operands: [modrmReg("r16"), modrmRm("rm16")],
      syntax: `cmov${descriptor.suffix} {0}, {1}`,
      semantics: cmovSemantic(descriptor.cc, 16)
    }),
    // 0F 40+cc /r: CMOVcc r32, r/m32
    form("r32_rm32", {
      opcode: [0x0f, 0x40 + descriptor.opcodeLow],
      operands: [modrmReg("r32"), modrmRm("rm32")],
      syntax: `cmov${descriptor.suffix} {0}, {1}`,
      semantics: cmovSemantic(descriptor.cc)
    })
  ])
);

export const MOVZX = mnemonic("movzx", [
  // 66 0F B6 /r: MOVZX r16, r/m8
  form("r16_rm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xb6],
    operands: [modrmReg("r16"), modrmRm("rm8")],
    syntax: "movzx {0}, {1}",
    semantics: movzxSemantic(8, 16)
  }),
  // 0F B6 /r: MOVZX r32, r/m8
  form("r32_rm8", {
    opcode: [0x0f, 0xb6],
    operands: [modrmReg("r32"), modrmRm("rm8")],
    syntax: "movzx {0}, {1}",
    semantics: movzxSemantic(8, 32)
  }),
  // 0F B7 /r: MOVZX r32, r/m16
  form("r32_rm16", {
    opcode: [0x0f, 0xb7],
    operands: [modrmReg("r32"), modrmRm("rm16")],
    syntax: "movzx {0}, {1}",
    semantics: movzxSemantic(16, 32)
  })
]);

export const MOVSX = mnemonic("movsx", [
  // 66 0F BE /r: MOVSX r16, r/m8
  form("r16_rm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xbe],
    operands: [modrmReg("r16"), modrmRm("rm8")],
    syntax: "movsx {0}, {1}",
    semantics: movsxSemantic(8, 16)
  }),
  // 0F BE /r: MOVSX r32, r/m8
  form("r32_rm8", {
    opcode: [0x0f, 0xbe],
    operands: [modrmReg("r32"), modrmRm("rm8")],
    syntax: "movsx {0}, {1}",
    semantics: movsxSemantic(8, 32)
  }),
  // 0F BF /r: MOVSX r32, r/m16
  form("r32_rm16", {
    opcode: [0x0f, 0xbf],
    operands: [modrmReg("r32"), modrmRm("rm16")],
    syntax: "movsx {0}, {1}",
    semantics: movsxSemantic(16, 32)
  })
]);
