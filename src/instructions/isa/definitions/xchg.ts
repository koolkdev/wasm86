import { form, implicitReg, mnemonic, modrmReg, modrmRm, opcodePlusReg, opReg } from "../dsl.js";
import { xchgSemantic } from "#instructions/semantics/xchg.js";

export const XCHG = mnemonic("xchg", [
  // 66 90+rw: XCHG AX, r16.
  form("ax_r16", {
    opcode: [opcodePlusReg(0x90)],
    prefixes: { operandSize: "override" },
    operands: [implicitReg("ax"), opReg("r16")],
    syntax: "xchg {0}, {1}",
    semantics: xchgSemantic(16)
  }),
  // 90+rd: XCHG EAX, r32.
  form("eax_r32", {
    opcode: [opcodePlusReg(0x90)],
    operands: [implicitReg("eax"), opReg()],
    syntax: "xchg {0}, {1}",
    semantics: xchgSemantic(32)
  }),
  // 86 /r: XCHG r/m8, r8.
  form("rm8_r8", {
    opcode: [0x86],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    syntax: "xchg {0}, {1}",
    semantics: xchgSemantic(8)
  }),
  // 66 87 /r: XCHG r/m16, r16.
  form("rm16_r16", {
    opcode: [0x87],
    prefixes: { operandSize: "override" },
    operands: [modrmRm("rm16"), modrmReg("r16")],
    syntax: "xchg {0}, {1}",
    semantics: xchgSemantic(16)
  }),
  // 87 /r: XCHG r/m32, r32.
  form("rm32_r32", {
    opcode: [0x87],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    syntax: "xchg {0}, {1}",
    semantics: xchgSemantic(32)
  })
]);
