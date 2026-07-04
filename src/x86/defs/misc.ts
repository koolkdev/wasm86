import { form, imm, mnemonic, modrmRm } from "./dsl.js";
import { intSemantic, nopSemantic } from "#x86/semantics/misc.js";

export const NOP = mnemonic("nop", [
  // Alias for xchg eax, eax
  // form("near", {
  //   opcode: [0x90],
  //   syntax: "nop",
  //   semantics: nopSemantic()
  // }),
  // Alias for xchg ax, ax
  // form("operand_size_override", {
  //   opcode: [0x90],
  //   prefixes: { operandSize: "override" },
  //   syntax: "nop",
  //   semantics: nopSemantic()
  // }),
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

export const INT = mnemonic("int", [
  // CD ib: INT imm8
  form("imm8", {
    opcode: [0xcd],
    operands: [imm(8)],
    syntax: "int {0}",
    semantics: intSemantic()
  })
]);
