import { form, mnemonic, modrmReg, modrmRm } from "../dsl.js";
import {
  cmpxchg8bSemantic,
  cmpxchgSemantic,
  xaddSemantic
} from "#core/semantics/compare-exchange.js";

export const CMPXCHG = mnemonic("cmpxchg", [
  // 0F B0 /r: CMPXCHG r/m8, r8.
  form("rm8_r8", {
    opcode: [0x0f, 0xb0],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "cmpxchg {0}, {1}",
    semantics: cmpxchgSemantic(8)
  }),
  // 66 0F B1 /r: CMPXCHG r/m16, r16.
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xb1],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "cmpxchg {0}, {1}",
    semantics: cmpxchgSemantic(16)
  }),
  // 0F B1 /r: CMPXCHG r/m32, r32.
  form("rm32_r32", {
    opcode: [0x0f, 0xb1],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "cmpxchg {0}, {1}",
    semantics: cmpxchgSemantic(32)
  })
]);

export const XADD = mnemonic("xadd", [
  // 0F C0 /r: XADD r/m8, r8.
  form("rm8_r8", {
    opcode: [0x0f, 0xc0],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "xadd {0}, {1}",
    semantics: xaddSemantic(8)
  }),
  // 66 0F C1 /r: XADD r/m16, r16.
  form("rm16_r16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xc1],
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "xadd {0}, {1}",
    semantics: xaddSemantic(16)
  }),
  // 0F C1 /r: XADD r/m32, r32.
  form("rm32_r32", {
    opcode: [0x0f, 0xc1],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "xadd {0}, {1}",
    semantics: xaddSemantic(32)
  })
]);

export const CMPXCHG8B = mnemonic("cmpxchg8b", [
  // 0F C7 /1: CMPXCHG8B m64.
  form("m64", {
    opcode: [0x0f, 0xc7],
    modrm: { match: { reg: 1 } },
    operands: [modrmRm("m64")],
    syntax: "cmpxchg8b {0}",
    semantics: cmpxchg8bSemantic()
  })
]);
