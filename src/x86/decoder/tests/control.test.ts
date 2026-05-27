import { imm8, imm16, imm32, reg32, relTarget, signImm8, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "nop",
    bytes: [0x90],
    mnemonic: "nop",
    id: "nop.near",
    format: "nop"
  },
  {
    name: "operand-size prefixed nop",
    bytes: [0x66, 0x90],
    mnemonic: "nop",
    id: "nop.operand_size_override",
    format: "nop"
  },
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
    name: "jmp rel32 -5",
    bytes: [0xe9, 0xfb, 0xff, 0xff, 0xff],
    mnemonic: "jmp",
    operands: [relTarget(32, -5, 0x1000)],
    id: "jmp.rel32"
  },
  {
    name: "call rel32",
    bytes: [0xe8, 0x05, 0x00, 0x00, 0x00],
    mnemonic: "call",
    operands: [relTarget(32, 5, 0x100a)],
    id: "call.rel32"
  },
  {
    name: "ret",
    bytes: [0xc3],
    mnemonic: "ret",
    id: "ret.near"
  },
  {
    name: "ret imm16",
    bytes: [0xc2, 0x08, 0x00],
    mnemonic: "ret",
    operands: [imm16(8)],
    id: "ret.imm16"
  },
  {
    name: "je rel8",
    bytes: [0x74, 0x05],
    mnemonic: "je",
    operands: [relTarget(8, 5, 0x1007)],
    id: "je.rel8"
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
    name: "push imm8",
    bytes: [0x6a, 0xff],
    mnemonic: "push",
    operands: [signImm8(0xffff_ffff)],
    id: "push.imm8"
  }
];

testDecodeFixtures(fixtures);
