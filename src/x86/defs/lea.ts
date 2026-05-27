import { form, mnemonic } from "#x86/schema/builders.js";
import { modrmReg, modrmRm } from "#x86/schema/operands.js";
import { leaSemantic } from "#x86/semantics/lea.js";

export const LEA = mnemonic("lea", [
  // 66 8D /r: LEA r16, m16
  form("r16_m16", {
    prefixes: { operandSize: "override" },
    opcode: [0x8d],
    operands: [modrmReg("r16"), modrmRm("m16")],
    format: { syntax: "lea {0}, {1}" },
    semantics: leaSemantic(16)
  }),
  // 8D /r: LEA r32, m32
  form("r32_m32", {
    opcode: [0x8d],
    operands: [modrmReg("r32"), modrmRm("m32")],
    format: { syntax: "lea {0}, {1}" },
    semantics: leaSemantic()
  })
]);
