import { form, mnemonic } from "#x86/schema/builders.js";
import { modrmReg, modrmRm } from "#x86/schema/operands.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";

export const XCHG = mnemonic("xchg", [
  // 86 /r: XCHG r/m8, r8.
  form("rm8_r8", {
    opcode: [0x86],
    operands: [modrmRm("rm8"), modrmReg("r8")],
    format: { syntax: "xchg {0}, {1}" },
    semantics: xchgSemantic(8)
  }),
  // 66 87 /r: XCHG r/m16, r16.
  form("rm16_r16", {
    opcode: [0x87],
    prefixes: { operandSize: "override" },
    operands: [modrmRm("rm16"), modrmReg("r16")],
    format: { syntax: "xchg {0}, {1}" },
    semantics: xchgSemantic(16)
  }),
  // 87 /r: XCHG r/m32, r32.
  form("rm32_r32", {
    opcode: [0x87],
    operands: [modrmRm("rm32"), modrmReg("r32")],
    format: { syntax: "xchg {0}, {1}" },
    semantics: xchgSemantic(32)
  })
]);
