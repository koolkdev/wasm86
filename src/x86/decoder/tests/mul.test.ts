import {
  imm16,
  imm32,
  mem,
  mem32,
  reg,
  reg32,
  signImm8,
  testDecodeFixtures,
  type DecoderFixture
} from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "mul bl",
    bytes: [0xf6, 0xe3],
    mnemonic: "mul",
    operands: [reg("bl")],
    id: "mul.rm8",
    format: "mul {0}"
  },
  {
    name: "mul bx with operand-size override",
    bytes: [0x66, 0xf7, 0xe3],
    mnemonic: "mul",
    operands: [reg("bx")],
    id: "mul.rm16"
  },
  {
    name: "mul ebx",
    bytes: [0xf7, 0xe3],
    mnemonic: "mul",
    operands: [reg32("ebx")],
    id: "mul.rm32"
  },
  {
    name: "mul dword [ebx]",
    bytes: [0xf7, 0x23],
    mnemonic: "mul",
    operands: [mem32({ base: "ebx", scale: 1, disp: 0 })],
    id: "mul.rm32"
  },
  {
    name: "imul bl implicit accumulator",
    bytes: [0xf6, 0xeb],
    mnemonic: "imul",
    operands: [reg("bl")],
    id: "imul.rm8",
    format: "imul {0}"
  },
  {
    name: "imul bx implicit accumulator with operand-size override",
    bytes: [0x66, 0xf7, 0xeb],
    mnemonic: "imul",
    operands: [reg("bx")],
    id: "imul.rm16"
  },
  {
    name: "imul ebx implicit accumulator",
    bytes: [0xf7, 0xeb],
    mnemonic: "imul",
    operands: [reg32("ebx")],
    id: "imul.rm32"
  },
  {
    name: "imul byte [ebx] implicit accumulator",
    bytes: [0xf6, 0x2b],
    mnemonic: "imul",
    operands: [mem(8, { base: "ebx", scale: 1, disp: 0 })],
    id: "imul.rm8"
  },
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
