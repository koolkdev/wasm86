import { form, imm, mnemonic, modrmRm } from "./dsl.js";
import { intSemantic, nopSemantic } from "#x86/semantics/misc.js";

export const NOP = mnemonic("nop", [
  // 90 and 66 90 stay xchg (e)ax, (e)ax: architecturally identical
  // to nop in IA-32, so no forms here.
  // 66 0F 1F /0: multi-byte NOP r/m16
  form("rm16", {
    opcode: [0x0f, 0x1f],
    prefixes: { operandSize: "override" },
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16")],
    syntax: "nop {0}",
    semantics: nopSemantic()
  }),
  // 0F 1F /0: multi-byte NOP r/m32
  form("rm32", {
    opcode: [0x0f, 0x1f],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32")],
    syntax: "nop {0}",
    semantics: nopSemantic()
  })
]);

export const WAIT = mnemonic("wait", [
  // 9B: WAIT/FWAIT. With no FPU modeled there are no pending numeric
  // exceptions to observe; revisit this when an FPU series exists.
  form("near", {
    opcode: [0x9b],
    syntax: "wait",
    semantics: nopSemantic()
  })
]);

export const INT = mnemonic("int", [
  // CD ib: INT imm8
  form("imm8", {
    opcode: [0xcd],
    operands: [imm(8)],
    syntax: "int {0}",
    semantics: intSemantic()
  })
]);
