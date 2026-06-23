import { form, mnemonic } from "#x86/schema/builders.js";
import { imm, modrmRm, opReg } from "#x86/schema/operands.js";
import { opcodePlusReg } from "#x86/schema/opcodes.js";
import { leaveSemantic, popSemantic, pushfdSemantic, pushSemantic } from "#x86/semantics/stack.js";

export const PUSH = mnemonic("push", [
  // 50+rd: PUSH r32
  form("r32", {
    opcode: [opcodePlusReg(0x50)],
    operands: [opReg()],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // FF /6: PUSH r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32")],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // 68 id: PUSH imm32
  form("imm32", {
    opcode: [0x68],
    operands: [imm(32)],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // 6A ib: PUSH sign-extended imm8
  form("imm8", {
    opcode: [0x6a],
    operands: [imm(8, "sign", 32)],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  })
]);

export const POP = mnemonic("pop", [
  // 58+rd: POP r32
  form("r32", {
    opcode: [opcodePlusReg(0x58)],
    operands: [opReg()],
    format: { syntax: "pop {0}" },
    semantics: popSemantic()
  }),
  // 8F /0: POP r/m32
  form("rm32", {
    opcode: [0x8f],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32")],
    format: { syntax: "pop {0}" },
    semantics: popSemantic()
  })
]);

export const PUSHFD = mnemonic("pushfd", [
  // 9C: PUSHFD
  form("dword", {
    opcode: [0x9c],
    format: { syntax: "pushfd" },
    semantics: pushfdSemantic()
  })
]);

export const LEAVE = mnemonic("leave", [
  // C9: LEAVE
  form("near", {
    opcode: [0xc9],
    format: { syntax: "leave" },
    semantics: leaveSemantic()
  })
]);
