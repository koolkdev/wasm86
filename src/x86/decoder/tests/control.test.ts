import { imm8, imm16, imm32, mem, mem32, reg, reg32, relTarget, signImm8, sreg, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "int imm8",
    bytes: [0xcd, 0x2e],
    mnemonic: "int",
    operands: [imm8(0x2e)],
    id: "int.imm8",
    format: "int {0}"
  },
  {
    name: "jmp rel8 5",
    bytes: [0xeb, 0x05],
    mnemonic: "jmp",
    operands: [relTarget(8, 5, 0x1007)],
    id: "jmp.rel8"
  },
  {
    name: "jmp rel8 -2",
    bytes: [0xeb, 0xfe],
    mnemonic: "jmp",
    operands: [relTarget(8, -2, 0x1000)],
    id: "jmp.rel8"
  },
  {
    name: "jmp rel16 -5",
    bytes: [0x66, 0xe9, 0xfb, 0xff],
    mnemonic: "jmp",
    operands: [relTarget(16, -5, 0x0fff)],
    id: "jmp.rel16"
  },
  {
    name: "jmp rel32 -5",
    bytes: [0xe9, 0xfb, 0xff, 0xff, 0xff],
    mnemonic: "jmp",
    operands: [relTarget(32, -5, 0x1000)],
    id: "jmp.rel32"
  },
  {
    name: "jmp r/m16",
    bytes: [0x66, 0xff, 0xe3],
    mnemonic: "jmp",
    operands: [reg("bx")],
    id: "jmp.rm16"
  },
  {
    name: "call rel32",
    bytes: [0xe8, 0x05, 0x00, 0x00, 0x00],
    mnemonic: "call",
    operands: [relTarget(32, 5, 0x100a)],
    id: "call.rel32"
  },
  {
    name: "call rel16",
    bytes: [0x66, 0xe8, 0x05, 0x00],
    mnemonic: "call",
    operands: [relTarget(16, 5, 0x1009)],
    id: "call.rel16"
  },
  {
    name: "call r/m16",
    bytes: [0x66, 0xff, 0xd0],
    mnemonic: "call",
    operands: [reg("ax")],
    id: "call.rm16"
  },
  {
    name: "ret",
    bytes: [0xc3],
    mnemonic: "ret",
    id: "ret.near"
  },
  {
    name: "ret operand-size",
    bytes: [0x66, 0xc3],
    mnemonic: "ret",
    id: "ret.near_o16"
  },
  {
    name: "ret imm16",
    bytes: [0xc2, 0x08, 0x00],
    mnemonic: "ret",
    operands: [imm16(8)],
    id: "ret.imm16"
  },
  {
    name: "ret imm16 operand-size",
    bytes: [0x66, 0xc2, 0x08, 0x00],
    mnemonic: "ret",
    operands: [imm16(8)],
    id: "ret.imm16_o16"
  },
  {
    name: "je rel8",
    bytes: [0x74, 0x05],
    mnemonic: "je",
    operands: [relTarget(8, 5, 0x1007)],
    id: "je.rel8"
  },
  {
    name: "je rel16",
    bytes: [0x66, 0x0f, 0x84, 0x05, 0x00],
    mnemonic: "je",
    operands: [relTarget(16, 5, 0x100a)],
    id: "je.rel16"
  },
  {
    name: "jne rel8",
    bytes: [0x75, 0xfb],
    mnemonic: "jne",
    operands: [relTarget(8, -5, 0x0ffd)],
    id: "jne.rel8"
  },
  {
    name: "jl rel8",
    bytes: [0x7c, 0x80],
    mnemonic: "jl",
    operands: [relTarget(8, -128, 0x0f82)],
    id: "jl.rel8"
  },
  {
    name: "je rel32",
    bytes: [0x0f, 0x84, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "je",
    operands: [relTarget(32, 0x1234_5678, 0x1234_667e)],
    id: "je.rel32"
  },
  {
    name: "jne rel32",
    bytes: [0x0f, 0x85, 0xfb, 0xff, 0xff, 0xff],
    mnemonic: "jne",
    operands: [relTarget(32, -5, 0x1001)],
    id: "jne.rel32"
  },
  {
    name: "jl rel32",
    bytes: [0x0f, 0x8c, 0x00, 0x00, 0x00, 0x00],
    mnemonic: "jl",
    operands: [relTarget(32, 0, 0x1006)],
    id: "jl.rel32"
  },
  {
    name: "push eax",
    bytes: [0x50],
    mnemonic: "push",
    operands: [reg32("eax")],
    id: "push.r32"
  },
  {
    name: "push edi",
    bytes: [0x57],
    mnemonic: "push",
    operands: [reg32("edi")],
    id: "push.r32"
  },
  {
    name: "push ax",
    bytes: [0x66, 0x50],
    mnemonic: "push",
    operands: [reg("ax")],
    id: "push.r16"
  },
  {
    name: "push es",
    bytes: [0x06],
    mnemonic: "push",
    operands: [sreg("es")],
    id: "push.es"
  },
  {
    name: "push fs",
    bytes: [0x0f, 0xa0],
    mnemonic: "push",
    operands: [sreg("fs")],
    id: "push.fs"
  },
  {
    name: "push gs with operand-size override",
    bytes: [0x66, 0x0f, 0xa8],
    mnemonic: "push",
    operands: [sreg("gs")],
    id: "push.gs_o16"
  },
  {
    name: "pop ecx",
    bytes: [0x59],
    mnemonic: "pop",
    operands: [reg32("ecx")],
    id: "pop.r32"
  },
  {
    name: "pop edi",
    bytes: [0x5f],
    mnemonic: "pop",
    operands: [reg32("edi")],
    id: "pop.r32"
  },
  {
    name: "pop ax",
    bytes: [0x66, 0x58],
    mnemonic: "pop",
    operands: [reg("ax")],
    id: "pop.r16"
  },
  {
    name: "pop ds",
    bytes: [0x1f],
    mnemonic: "pop",
    operands: [sreg("ds")],
    id: "pop.ds"
  },
  {
    name: "pop fs",
    bytes: [0x0f, 0xa1],
    mnemonic: "pop",
    operands: [sreg("fs")],
    id: "pop.fs"
  },
  {
    name: "pop gs with operand-size override",
    bytes: [0x66, 0x0f, 0xa9],
    mnemonic: "pop",
    operands: [sreg("gs")],
    id: "pop.gs_o16"
  },
  {
    name: "pop [eax]",
    bytes: [0x8f, 0x00],
    mnemonic: "pop",
    operands: [mem32({ base: "eax", scale: 1, disp: 0 })],
    id: "pop.rm32"
  },
  {
    name: "pop word [eax]",
    bytes: [0x66, 0x8f, 0x00],
    mnemonic: "pop",
    operands: [mem(16, { base: "eax", scale: 1, disp: 0 })],
    id: "pop.rm16"
  },
  {
    name: "leave",
    bytes: [0xc9],
    mnemonic: "leave",
    id: "leave.near",
    format: "leave"
  },
  {
    name: "push imm32",
    bytes: [0x68, 0x44, 0x33, 0x22, 0x11],
    mnemonic: "push",
    operands: [imm32(0x1122_3344)],
    id: "push.imm32"
  },
  {
    name: "push word [eax]",
    bytes: [0x66, 0xff, 0x30],
    mnemonic: "push",
    operands: [mem(16, { base: "eax", scale: 1, disp: 0 })],
    id: "push.rm16"
  },
  {
    name: "push imm16",
    bytes: [0x66, 0x68, 0x34, 0x12],
    mnemonic: "push",
    operands: [imm16(0x1234)],
    id: "push.imm16"
  },
  {
    name: "push imm8",
    bytes: [0x6a, 0xff],
    mnemonic: "push",
    operands: [signImm8(0xffff_ffff)],
    id: "push.imm8"
  },
  {
    name: "push operand-size imm8",
    bytes: [0x66, 0x6a, 0xff],
    mnemonic: "push",
    operands: [{ kind: "imm", value: 0xffff_ffff, encodedWidth: 8, semanticWidth: 16, extension: "sign" }],
    id: "push.imm8_o16"
  },
  {
    name: "pushfd",
    bytes: [0x9c],
    mnemonic: "pushfd",
    id: "pushfd.dword",
    format: "pushfd"
  },
  {
    name: "pushf",
    bytes: [0x66, 0x9c],
    mnemonic: "pushf",
    id: "pushf.word",
    format: "pushf"
  },
  {
    name: "popfd",
    bytes: [0x9d],
    mnemonic: "popfd",
    id: "popfd.dword",
    format: "popfd"
  },
  {
    name: "popf",
    bytes: [0x66, 0x9d],
    mnemonic: "popf",
    id: "popf.word",
    format: "popf"
  },
  {
    name: "cwde",
    bytes: [0x98],
    mnemonic: "cwde",
    id: "cwde.dword",
    format: "cwde"
  },
  {
    name: "cbw",
    bytes: [0x66, 0x98],
    mnemonic: "cbw",
    id: "cbw.word",
    format: "cbw"
  },
  {
    name: "cdq",
    bytes: [0x99],
    mnemonic: "cdq",
    id: "cdq.dword",
    format: "cdq"
  },
  {
    name: "cwd",
    bytes: [0x66, 0x99],
    mnemonic: "cwd",
    id: "cwd.word",
    format: "cwd"
  },
  {
    name: "pushad",
    bytes: [0x60],
    mnemonic: "pushad",
    id: "pushad.dword",
    format: "pushad"
  },
  {
    name: "pusha",
    bytes: [0x66, 0x60],
    mnemonic: "pusha",
    id: "pusha.word",
    format: "pusha"
  },
  {
    name: "popad",
    bytes: [0x61],
    mnemonic: "popad",
    id: "popad.dword",
    format: "popad"
  },
  {
    name: "popa",
    bytes: [0x66, 0x61],
    mnemonic: "popa",
    id: "popa.word",
    format: "popa"
  }
];

testDecodeFixtures(fixtures);
