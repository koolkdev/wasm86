import { form, mnemonic } from "#x86/schema/builders.js";
import { imm, modrmRm, opReg } from "#x86/schema/operands.js";
import { opcodePlusReg } from "#x86/schema/opcodes.js";
import {
  leaveSemantic,
  popfdSemantic,
  popfSemantic,
  popSemantic,
  pushfdSemantic,
  pushfSemantic,
  pushSemantic
} from "#x86/semantics/stack.js";

export const PUSH = mnemonic("push", [
  // 66 50+rw: PUSH r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x50)],
    operands: [opReg("r16")],
    format: { syntax: "push {0}" },
    semantics: pushSemantic(16)
  }),
  // 50+rd: PUSH r32
  form("r32", {
    opcode: [opcodePlusReg(0x50)],
    operands: [opReg()],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // 66 FF /6: PUSH r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16")],
    format: { syntax: "push {0}" },
    semantics: pushSemantic(16)
  }),
  // FF /6: PUSH r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32")],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // 66 68 iw: PUSH imm16
  form("imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x68],
    operands: [imm(16)],
    format: { syntax: "push {0}" },
    semantics: pushSemantic(16)
  }),
  // 68 id: PUSH imm32
  form("imm32", {
    opcode: [0x68],
    operands: [imm(32)],
    format: { syntax: "push {0}" },
    semantics: pushSemantic()
  }),
  // 66 6A ib: PUSH sign-extended imm8 to 16 bits
  form("imm8_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x6a],
    operands: [imm(8, "sign", 16)],
    format: { syntax: "push {0}" },
    semantics: pushSemantic(16)
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
  // 66 58+rw: POP r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x58)],
    operands: [opReg("r16")],
    format: { syntax: "pop {0}" },
    semantics: popSemantic(16)
  }),
  // 58+rd: POP r32
  form("r32", {
    opcode: [opcodePlusReg(0x58)],
    operands: [opReg()],
    format: { syntax: "pop {0}" },
    semantics: popSemantic()
  }),
  // 66 8F /0: POP r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x8f],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16")],
    format: { syntax: "pop {0}" },
    semantics: popSemantic(16)
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

export const PUSHF = mnemonic("pushf", [
  // 66 9C: PUSHF
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x9c],
    format: { syntax: "pushf" },
    semantics: pushfSemantic()
  })
]);

export const POPFD = mnemonic("popfd", [
  // 9D: POPFD
  form("dword", {
    opcode: [0x9d],
    format: { syntax: "popfd" },
    semantics: popfdSemantic()
  })
]);

export const POPF = mnemonic("popf", [
  // 66 9D: POPF
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x9d],
    format: { syntax: "popf" },
    semantics: popfSemantic()
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
