import { form, imm, implicitReg, mnemonic, modrmReg, modrmRm } from "../dsl.js";
import { testSemantic } from "#instructions/semantics/test.js";

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
