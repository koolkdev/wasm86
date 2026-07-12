import { form, imm, implicitSreg, mnemonic, modrmRm, opcodePlusReg, opReg } from "./dsl.js";
import {
  leaveSemantic,
  popadSemantic,
  popfdSemantic,
  popfSemantic,
  popSegmentSemantic,
  popaSemantic,
  popSemantic,
  pushadSemantic,
  pushfdSemantic,
  pushfSemantic,
  pushaSemantic,
  pushSemantic
} from "#core/semantics/stack.js";

export const PUSH = mnemonic("push", [
  // 66 50+rw: PUSH r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x50)],
    operands: [opReg("r16")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 50+rd: PUSH r32
  form("r32", {
    opcode: [opcodePlusReg(0x50)],
    operands: [opReg()],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 06: PUSH ES
  form("es", {
    opcode: [0x06],
    operands: [implicitSreg("es")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 0E: PUSH CS
  form("cs", {
    opcode: [0x0e],
    operands: [implicitSreg("cs")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 16: PUSH SS
  form("ss", {
    opcode: [0x16],
    operands: [implicitSreg("ss")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 1E: PUSH DS
  form("ds", {
    opcode: [0x1e],
    operands: [implicitSreg("ds")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 0F A0: PUSH FS
  form("fs", {
    opcode: [0x0f, 0xa0],
    operands: [implicitSreg("fs")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 0F A8: PUSH GS
  form("gs", {
    opcode: [0x0f, 0xa8],
    operands: [implicitSreg("gs")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 66 06: PUSH ES
  form("es_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x06],
    operands: [implicitSreg("es")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 0E: PUSH CS
  form("cs_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0e],
    operands: [implicitSreg("cs")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 16: PUSH SS
  form("ss_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x16],
    operands: [implicitSreg("ss")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 1E: PUSH DS
  form("ds_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x1e],
    operands: [implicitSreg("ds")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 0F A0: PUSH FS
  form("fs_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xa0],
    operands: [implicitSreg("fs")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 0F A8: PUSH GS
  form("gs_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xa8],
    operands: [implicitSreg("gs")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 66 FF /6: PUSH r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xff],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16")],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // FF /6: PUSH r/m32
  form("rm32", {
    opcode: [0xff],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32")],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 66 68 iw: PUSH imm16
  form("imm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x68],
    operands: [imm(16)],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 68 id: PUSH imm32
  form("imm32", {
    opcode: [0x68],
    operands: [imm(32)],
    syntax: "push {0}",
    semantics: pushSemantic()
  }),
  // 66 6A ib: PUSH sign-extended imm8 to 16 bits
  form("imm8_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x6a],
    operands: [imm(8, "sign", 16)],
    syntax: "push {0}",
    semantics: pushSemantic(16)
  }),
  // 6A ib: PUSH sign-extended imm8
  form("imm8", {
    opcode: [0x6a],
    operands: [imm(8, "sign", 32)],
    syntax: "push {0}",
    semantics: pushSemantic()
  })
]);

export const POP = mnemonic("pop", [
  // 66 58+rw: POP r16
  form("r16", {
    prefixes: { operandSize: "override" },
    opcode: [opcodePlusReg(0x58)],
    operands: [opReg("r16")],
    syntax: "pop {0}",
    semantics: popSemantic(16)
  }),
  // 58+rd: POP r32
  form("r32", {
    opcode: [opcodePlusReg(0x58)],
    operands: [opReg()],
    syntax: "pop {0}",
    semantics: popSemantic()
  }),
  // 07: POP ES
  form("es", {
    opcode: [0x07],
    operands: [implicitSreg("es")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic()
  }),
  // 17: POP SS
  form("ss", {
    opcode: [0x17],
    operands: [implicitSreg("ss")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic()
  }),
  // 1F: POP DS
  form("ds", {
    opcode: [0x1f],
    operands: [implicitSreg("ds")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic()
  }),
  // 0F A1: POP FS
  form("fs", {
    opcode: [0x0f, 0xa1],
    operands: [implicitSreg("fs")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic()
  }),
  // 0F A9: POP GS
  form("gs", {
    opcode: [0x0f, 0xa9],
    operands: [implicitSreg("gs")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic()
  }),
  // 66 07: POP ES
  form("es_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x07],
    operands: [implicitSreg("es")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic(16)
  }),
  // 66 17: POP SS
  form("ss_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x17],
    operands: [implicitSreg("ss")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic(16)
  }),
  // 66 1F: POP DS
  form("ds_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x1f],
    operands: [implicitSreg("ds")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic(16)
  }),
  // 66 0F A1: POP FS
  form("fs_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xa1],
    operands: [implicitSreg("fs")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic(16)
  }),
  // 66 0F A9: POP GS
  form("gs_o16", {
    prefixes: { operandSize: "override" },
    opcode: [0x0f, 0xa9],
    operands: [implicitSreg("gs")],
    syntax: "pop {0}",
    semantics: popSegmentSemantic(16)
  }),
  // 66 8F /0: POP r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0x8f],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm16")],
    syntax: "pop {0}",
    semantics: popSemantic(16)
  }),
  // 8F /0: POP r/m32
  form("rm32", {
    opcode: [0x8f],
    modrm: { match: { reg: 0 } },
    operands: [modrmRm("rm32")],
    syntax: "pop {0}",
    semantics: popSemantic()
  })
]);

export const PUSHAD = mnemonic("pushad", [
  // 60: PUSHAD
  form("dword", {
    opcode: [0x60],
    syntax: "pushad",
    semantics: pushadSemantic()
  })
]);

export const PUSHA = mnemonic("pusha", [
  // 66 60: PUSHA
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x60],
    syntax: "pusha",
    semantics: pushaSemantic()
  })
]);

export const POPAD = mnemonic("popad", [
  // 61: POPAD
  form("dword", {
    opcode: [0x61],
    syntax: "popad",
    semantics: popadSemantic()
  })
]);

export const POPA = mnemonic("popa", [
  // 66 61: POPA
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x61],
    syntax: "popa",
    semantics: popaSemantic()
  })
]);

export const PUSHFD = mnemonic("pushfd", [
  // 9C: PUSHFD
  form("dword", {
    opcode: [0x9c],
    syntax: "pushfd",
    semantics: pushfdSemantic()
  })
]);

export const PUSHF = mnemonic("pushf", [
  // 66 9C: PUSHF
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x9c],
    syntax: "pushf",
    semantics: pushfSemantic()
  })
]);

export const POPFD = mnemonic("popfd", [
  // 9D: POPFD
  form("dword", {
    opcode: [0x9d],
    syntax: "popfd",
    semantics: popfdSemantic()
  })
]);

export const POPF = mnemonic("popf", [
  // 66 9D: POPF
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x9d],
    syntax: "popf",
    semantics: popfSemantic()
  })
]);

export const LEAVE = mnemonic("leave", [
  // C9: LEAVE
  form("near", {
    opcode: [0xc9],
    syntax: "leave",
    semantics: leaveSemantic()
  })
]);
