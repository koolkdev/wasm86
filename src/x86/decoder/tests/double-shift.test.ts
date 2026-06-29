import { imm8, mem, reg, reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "shld eax, ebx, imm8",
    bytes: [0x0f, 0xa4, 0xd8, 0x04],
    mnemonic: "shld",
    operands: [reg32("eax"), reg32("ebx"), imm8(4)],
    id: "shld.rm32_r32_imm8",
    format: "shld {0}, {1}, {2}"
  },
  {
    name: "shld word [ebx], dx, cl with operand-size override",
    bytes: [0x66, 0x0f, 0xa5, 0x13],
    mnemonic: "shld",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), reg("dx"), reg("cl")],
    id: "shld.rm16_r16_cl"
  },
  {
    name: "shrd ecx, edx, cl",
    bytes: [0x0f, 0xad, 0xd1],
    mnemonic: "shrd",
    operands: [reg32("ecx"), reg32("edx"), reg("cl")],
    id: "shrd.rm32_r32_cl",
    format: "shrd {0}, {1}, {2}"
  },
  {
    name: "shrd word [ebx], dx, imm8 with operand-size override",
    bytes: [0x66, 0x0f, 0xac, 0x13, 0x04],
    mnemonic: "shrd",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), reg("dx"), imm8(4)],
    id: "shrd.rm16_r16_imm8"
  }
];

testDecodeFixtures(fixtures);
