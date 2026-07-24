import { form, imm, mnemonic, modrmReg, modrmRm } from "../dsl.js";
import { bitScanSemantic, bitTestSemantic } from "#instructions/semantics/bits.js";

export const BT = mnemonic("bt", [
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xa3],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "bt {0}, {1}",
    semantics: bitTestSemantic("bt", 16, "reg")
  }),
  form("rm32_r32", {
    opcode: [0x0f, 0xa3],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "bt {0}, {1}",
    semantics: bitTestSemantic("bt", 32, "reg")
  }),
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm16"), imm(8)],
    syntax: "bt {0}, {1}",
    semantics: bitTestSemantic("bt", 16, "imm8")
  }),
  form("rm32_imm8", {
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 4 } },
    operands: [modrmRm("rm32"), imm(8)],
    syntax: "bt {0}, {1}",
    semantics: bitTestSemantic("bt", 32, "imm8")
  })
]);

export const BTS = mnemonic("bts", [
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xab],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "bts {0}, {1}",
    semantics: bitTestSemantic("bts", 16, "reg")
  }),
  form("rm32_r32", {
    opcode: [0x0f, 0xab],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "bts {0}, {1}",
    semantics: bitTestSemantic("bts", 32, "reg")
  }),
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm16"), imm(8)],
    syntax: "bts {0}, {1}",
    semantics: bitTestSemantic("bts", 16, "imm8")
  }),
  form("rm32_imm8", {
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm32"), imm(8)],
    syntax: "bts {0}, {1}",
    semantics: bitTestSemantic("bts", 32, "imm8")
  })
]);

export const BTR = mnemonic("btr", [
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xb3],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "btr {0}, {1}",
    semantics: bitTestSemantic("btr", 16, "reg")
  }),
  form("rm32_r32", {
    opcode: [0x0f, 0xb3],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "btr {0}, {1}",
    semantics: bitTestSemantic("btr", 32, "reg")
  }),
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16"), imm(8)],
    syntax: "btr {0}, {1}",
    semantics: bitTestSemantic("btr", 16, "imm8")
  }),
  form("rm32_imm8", {
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32"), imm(8)],
    syntax: "btr {0}, {1}",
    semantics: bitTestSemantic("btr", 32, "imm8")
  })
]);

export const BTC = mnemonic("btc", [
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xbb],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "btc {0}, {1}",
    semantics: bitTestSemantic("btc", 16, "reg")
  }),
  form("rm32_r32", {
    opcode: [0x0f, 0xbb],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "btc {0}, {1}",
    semantics: bitTestSemantic("btc", 32, "reg")
  }),
  form("rm16_imm8", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm16"), imm(8)],
    syntax: "btc {0}, {1}",
    semantics: bitTestSemantic("btc", 16, "imm8")
  }),
  form("rm32_imm8", {
    opcode: [0x0f, 0xba],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm32"), imm(8)],
    syntax: "btc {0}, {1}",
    semantics: bitTestSemantic("btc", 32, "imm8")
  })
]);

export const BSF = mnemonic("bsf", [
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xbc],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "bsf {0}, {1}",
    semantics: bitScanSemantic("bsf", 16)
  }),
  form("r32_rm32", {
    opcode: [0x0f, 0xbc],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "bsf {0}, {1}",
    semantics: bitScanSemantic("bsf", 32)
  })
]);

export const BSR = mnemonic("bsr", [
  form("r16_rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xbd],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    syntax: "bsr {0}, {1}",
    semantics: bitScanSemantic("bsr", 16)
  }),
  form("r32_rm32", {
    opcode: [0x0f, 0xbd],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    syntax: "bsr {0}, {1}",
    semantics: bitScanSemantic("bsr", 32)
  })
]);
