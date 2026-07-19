import { form, imm, implicitReg, mnemonic, modrmReg, modrmRm } from "../dsl.js";
import { cmpSemantic } from "#core/semantics/cmp.js";
import { testSemantic } from "#core/semantics/test.js";

export const CMP = mnemonic("cmp", [
  // 38 /r: CMP r/m8, r8
  form("rm8_r8", {
    opcode: [0x38],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(8)
  }),
  // 3A /r: CMP r8, r/m8
  form("r8_rm8", {
    opcode: [0x3a],
    operands: [modrmReg("r8"), modrmRm("rm8")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(8)
  }),
  // 3C ib: CMP AL, imm8
  form("al_imm8", {
    opcode: [0x3c],
    operands: [implicitReg("al"), imm(8)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(8)
  }),
  // 80 /7 ib: CMP r/m8, imm8
  form("rm8_imm8", {
    opcode: [0x80],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(8)
  }),
  // 66 39 /r: CMP r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x39],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(16)
  }),
  // 66 3B /r: CMP r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x3b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(16)
  }),
  // 39 /r: CMP r/m32, r32
  form("rm32_r32", {
    opcode: [0x39],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic()
  }),
  // 3B /r: CMP r32, r/m32
  form("r32_rm32", {
    opcode: [0x3b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic()
  }),
  // 3D id: CMP EAX, imm32
  form("eax_imm32", {
    opcode: [0x3d],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic()
  }),
  // 66 3D iw: CMP AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x3d],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(16)
  }),
  // 81 /7 id: CMP r/m32, imm32
  form("rm32_imm32", {
    opcode: [0x81],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic()
  }),
  // 66 81 /7 iw: CMP r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x81],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(16)
  }),
  // 66 83 /7 ib: CMP r/m16, sign-extended imm8
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x83],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic(16)
  }),
  // 83 /7 ib: CMP r/m32, sign-extended imm8
  form("rm32_imm8", {
    opcode: [0x83],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "cmp {0}, {1}",
    semantics: cmpSemantic()
  })
]);

export const TEST = mnemonic("test", [
  // 84 /r: TEST r/m8, r8
  form("rm8_r8", {
    opcode: [0x84],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "test {0}, {1}",
    semantics: testSemantic(8)
  }),
  // A8 ib: TEST AL, imm8
  form("al_imm8", {
    opcode: [0xa8],
    operands: [implicitReg("al"), imm(8)],
    syntax: "test {0}, {1}",
    semantics: testSemantic(8)
  }),
  // F6 /0 ib: TEST r/m8, imm8
  form("rm8_imm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm8"), imm(8)],
    syntax: "test {0}, {1}",
    semantics: testSemantic(8)
  }),
  // 66 85 /r: TEST r/m16, r16
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x85],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "test {0}, {1}",
    semantics: testSemantic(16)
  }),
  // 85 /r: TEST r/m32, r32
  form("rm32_r32", {
    opcode: [0x85],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "test {0}, {1}",
    semantics: testSemantic()
  }),
  // A9 id: TEST EAX, imm32
  form("eax_imm32", {
    opcode: [0xa9],
    operands: [implicitReg("eax"), imm(32)],
    syntax: "test {0}, {1}",
    semantics: testSemantic()
  }),
  // 66 A9 iw: TEST AX, imm16
  form("ax_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xa9],
    operands: [implicitReg("ax"), imm(16)],
    syntax: "test {0}, {1}",
    semantics: testSemantic(16)
  }),
  // 66 F7 /0 iw: TEST r/m16, imm16
  form("rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16"), imm(16)],
    syntax: "test {0}, {1}",
    semantics: testSemantic(16)
  }),
  // F7 /0 id: TEST r/m32, imm32
  form("rm32_imm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32"), imm(32)],
    syntax: "test {0}, {1}",
    semantics: testSemantic()
  })
]);
