import { form, imm, mnemonic, modrmReg, modrmRm } from "./dsl.js";
import {
  imulImplicitSemantic,
  imulRegRmImmSemantic,
  imulRegRmSemantic,
  mulImplicitSemantic
} from "#core/semantics/mul.js";

export const MUL = mnemonic("mul", [
  // F6 /4: MUL r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm8")],
    syntax: "mul {0}",
    semantics: mulImplicitSemantic(8)
  }),
  // 66 F7 /4: MUL r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm16")],
    syntax: "mul {0}",
    semantics: mulImplicitSemantic(16)
  }),
  // F7 /4: MUL r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm32")],
    syntax: "mul {0}",
    semantics: mulImplicitSemantic(32)
  })
]);

export const IMUL = mnemonic("imul", [
  // F6 /5: IMUL r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm8")],
    syntax: "imul {0}",
    semantics: imulImplicitSemantic(8)
  }),
  // 66 F7 /5: IMUL r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm16")],
    syntax: "imul {0}",
    semantics: imulImplicitSemantic(16)
  }),
  // F7 /5: IMUL r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm32")],
    syntax: "imul {0}",
    semantics: imulImplicitSemantic(32)
  }),
  // 66 0F AF /r: IMUL r16, r/m16
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xaf],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "imul {0}, {1}",
    semantics: imulRegRmSemantic(16)
  }),
  // 0F AF /r: IMUL r32, r/m32
  form("r32_rm32", {
    opcode: [0x0f, 0xaf],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "imul {0}, {1}",
    semantics: imulRegRmSemantic(32)
  }),
  // 66 69 /r iw: IMUL r16, r/m16, imm16
  form("r16_rm16_imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x69],
    operands: [modrmReg("r16"), modrmRm("rm16"), imm(16)],
    syntax: "imul {0}, {1}, {2}",
    semantics: imulRegRmImmSemantic(16)
  }),
  // 69 /r id: IMUL r32, r/m32, imm32
  form("r32_rm32_imm32", {
    opcode: [0x69],
    operands: [modrmReg("r32"), modrmRm("rm32"), imm(32)],
    syntax: "imul {0}, {1}, {2}",
    semantics: imulRegRmImmSemantic(32)
  }),
  // 66 6B /r ib: IMUL r16, r/m16, sign-extended imm8
  form("r16_rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x6b],
    operands: [modrmReg("r16"), modrmRm("rm16"), imm(8, "sign", 16)],
    syntax: "imul {0}, {1}, {2}",
    semantics: imulRegRmImmSemantic(16)
  }),
  // 6B /r ib: IMUL r32, r/m32, sign-extended imm8
  form("r32_rm32_imm8", {
    opcode: [0x6b],
    operands: [modrmReg("r32"), modrmRm("rm32"), imm(8, "sign", 32)],
    syntax: "imul {0}, {1}, {2}",
    semantics: imulRegRmImmSemantic(32)
  })
]);
