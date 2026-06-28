import { imm8, mem, reg, reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "rol al, 1",
    bytes: [0xd0, 0xc0],
    mnemonic: "rol",
    operands: [reg("al")],
    id: "rol.rm8_1",
    format: "rol {0}, 1"
  },
  {
    name: "rol ebx, 1",
    bytes: [0xd1, 0xc3],
    mnemonic: "rol",
    operands: [reg32("ebx")],
    id: "rol.rm32_1"
  },
  {
    name: "ror bx, imm8 with operand-size override",
    bytes: [0x66, 0xc1, 0xcb, 0x04],
    mnemonic: "ror",
    operands: [reg("bx"), imm8(4)],
    id: "ror.rm16_imm8",
    format: "ror {0}, {1}"
  },
  {
    name: "ror byte [ebx], cl",
    bytes: [0xd2, 0x0b],
    mnemonic: "ror",
    operands: [mem(8, { base: "ebx", scale: 1, disp: 0 }), reg("cl")],
    id: "ror.rm8_cl"
  },
  {
    name: "rcl bl, cl",
    bytes: [0xd2, 0xd3],
    mnemonic: "rcl",
    operands: [reg("bl"), reg("cl")],
    id: "rcl.rm8_cl",
    format: "rcl {0}, {1}"
  },
  {
    name: "rcl word [ebx], imm8",
    bytes: [0x66, 0xc1, 0x13, 0x09],
    mnemonic: "rcl",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), imm8(9)],
    id: "rcl.rm16_imm8"
  },
  {
    name: "rcr ebx, 1",
    bytes: [0xd1, 0xdb],
    mnemonic: "rcr",
    operands: [reg32("ebx")],
    id: "rcr.rm32_1",
    format: "rcr {0}, 1"
  },
  {
    name: "rcr ebx, cl",
    bytes: [0xd3, 0xdb],
    mnemonic: "rcr",
    operands: [reg32("ebx"), reg("cl")],
    id: "rcr.rm32_cl"
  }
];

testDecodeFixtures(fixtures);
