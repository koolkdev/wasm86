import { imm8, mem, reg, reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "bt eax, ecx",
    bytes: [0x0f, 0xa3, 0xc8],
    mnemonic: "bt",
    operands: [reg32("eax"), reg32("ecx")],
    id: "bt.rm32_r32",
    format: "bt {0}, {1}"
  },
  {
    name: "bt word [ebx], dx with operand-size override",
    bytes: [0x66, 0x0f, 0xa3, 0x13],
    mnemonic: "bt",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), reg("dx")],
    id: "bt.rm16_r16"
  },
  {
    name: "bts word [ebx], imm8 with operand-size override",
    bytes: [0x66, 0x0f, 0xba, 0x2b, 0x0f],
    mnemonic: "bts",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), imm8(15)],
    id: "bts.rm16_imm8"
  },
  {
    name: "btr eax, imm8",
    bytes: [0x0f, 0xba, 0xf0, 0x1f],
    mnemonic: "btr",
    operands: [reg32("eax"), imm8(31)],
    id: "btr.rm32_imm8"
  },
  {
    name: "btc dword [eax + 4], ecx",
    bytes: [0x0f, 0xbb, 0x48, 0x04],
    mnemonic: "btc",
    operands: [mem(32, { base: "eax", scale: 1, disp: 4 }), reg32("ecx")],
    id: "btc.rm32_r32"
  },
  {
    name: "bsf ax, word [ebx] with operand-size override",
    bytes: [0x66, 0x0f, 0xbc, 0x03],
    mnemonic: "bsf",
    operands: [reg("ax"), mem(16, { base: "ebx", scale: 1, disp: 0 })],
    id: "bsf.r16_rm16"
  },
  {
    name: "bsr ecx, edx",
    bytes: [0x0f, 0xbd, 0xca],
    mnemonic: "bsr",
    operands: [reg32("ecx"), reg32("edx")],
    id: "bsr.r32_rm32",
    format: "bsr {0}, {1}"
  }
];

testDecodeFixtures(fixtures);
