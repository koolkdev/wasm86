import { imm16, imm32, mem32, reg, reg32, signImm8, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "imul eax, ebx",
    bytes: [0x0f, 0xaf, 0xc3],
    mnemonic: "imul",
    operands: [reg32("eax"), reg32("ebx")],
    id: "imul.r32_rm32",
    format: "imul {0}, {1}"
  },
  {
    name: "imul cx, bx with operand-size override",
    bytes: [0x66, 0x0f, 0xaf, 0xcb],
    mnemonic: "imul",
    operands: [reg("cx"), reg("bx")],
    id: "imul.r16_rm16"
  },
  {
    name: "imul eax, [ebx]",
    bytes: [0x0f, 0xaf, 0x03],
    mnemonic: "imul",
    operands: [reg32("eax"), mem32({ base: "ebx", scale: 1, disp: 0 })],
    id: "imul.r32_rm32"
  },
  {
    name: "imul eax, ebx, imm32",
    bytes: [0x69, 0xc3, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "imul",
    operands: [reg32("eax"), reg32("ebx"), imm32(0x1234_5678)],
    id: "imul.r32_rm32_imm32",
    format: "imul {0}, {1}, {2}"
  },
  {
    name: "imul cx, bx, imm16 with operand-size override",
    bytes: [0x66, 0x69, 0xcb, 0x34, 0x12],
    mnemonic: "imul",
    operands: [reg("cx"), reg("bx"), imm16(0x1234)],
    id: "imul.r16_rm16_imm16"
  },
  {
    name: "imul eax, ebx, imm8",
    bytes: [0x6b, 0xc3, 0xfe],
    mnemonic: "imul",
    operands: [reg32("eax"), reg32("ebx"), signImm8(0xffff_fffe)],
    id: "imul.r32_rm32_imm8"
  },
  {
    name: "imul cx, bx, imm8 with operand-size override",
    bytes: [0x66, 0x6b, 0xcb, 0xfe],
    mnemonic: "imul",
    operands: [
      reg("cx"),
      reg("bx"),
      { kind: "imm", value: 0xffff_fffe, encodedWidth: 8, semanticWidth: 16, extension: "sign" }
    ],
    id: "imul.r16_rm16_imm8"
  }
];

testDecodeFixtures(fixtures);
