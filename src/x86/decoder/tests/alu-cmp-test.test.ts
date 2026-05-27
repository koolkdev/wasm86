import { imm16, imm32, mem, mem32, reg, reg32, signImm8, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "add [eax], bl",
    bytes: [0x00, 0x18],
    mnemonic: "add",
    operands: [mem(8, { base: "eax", scale: 1, disp: 0 }), reg("bl")],
    id: "add.rm8_r8"
  },
  {
    name: "add eax, ebx",
    bytes: [0x01, 0xd8],
    mnemonic: "add",
    operands: [reg32("eax"), reg32("ebx")],
    id: "add.rm32_r32"
  },
  {
    name: "add ebx, eax",
    bytes: [0x03, 0xd8],
    mnemonic: "add",
    operands: [reg32("ebx"), reg32("eax")],
    id: "add.r32_rm32"
  },
  {
    name: "or eax, ebx",
    bytes: [0x09, 0xd8],
    mnemonic: "or",
    operands: [reg32("eax"), reg32("ebx")],
    id: "or.rm32_r32"
  },
  {
    name: "or ebx, eax",
    bytes: [0x0b, 0xd8],
    mnemonic: "or",
    operands: [reg32("ebx"), reg32("eax")],
    id: "or.r32_rm32"
  },
  {
    name: "and eax, ebx",
    bytes: [0x21, 0xd8],
    mnemonic: "and",
    operands: [reg32("eax"), reg32("ebx")],
    id: "and.rm32_r32"
  },
  {
    name: "and ebx, eax",
    bytes: [0x23, 0xd8],
    mnemonic: "and",
    operands: [reg32("ebx"), reg32("eax")],
    id: "and.r32_rm32"
  },
  {
    name: "sub eax, ebx",
    bytes: [0x29, 0xd8],
    mnemonic: "sub",
    operands: [reg32("eax"), reg32("ebx")],
    id: "sub.rm32_r32"
  },
  {
    name: "sub ebx, eax",
    bytes: [0x2b, 0xd8],
    mnemonic: "sub",
    operands: [reg32("ebx"), reg32("eax")],
    id: "sub.r32_rm32"
  },
  {
    name: "xor eax, ebx",
    bytes: [0x31, 0xd8],
    mnemonic: "xor",
    operands: [reg32("eax"), reg32("ebx")],
    id: "xor.rm32_r32"
  },
  {
    name: "xor ebx, eax",
    bytes: [0x33, 0xd8],
    mnemonic: "xor",
    operands: [reg32("ebx"), reg32("eax")],
    id: "xor.r32_rm32"
  },
  {
    name: "cmp eax, ebx",
    bytes: [0x39, 0xd8],
    mnemonic: "cmp",
    operands: [reg32("eax"), reg32("ebx")],
    id: "cmp.rm32_r32"
  },
  {
    name: "cmp ebx, eax",
    bytes: [0x3b, 0xd8],
    mnemonic: "cmp",
    operands: [reg32("ebx"), reg32("eax")],
    id: "cmp.r32_rm32"
  },
  {
    name: "test eax, ebx",
    bytes: [0x85, 0xd8],
    mnemonic: "test",
    operands: [reg32("eax"), reg32("ebx")],
    id: "test.rm32_r32"
  },
  {
    name: "inc eax",
    bytes: [0x40],
    mnemonic: "inc",
    operands: [reg32("eax")],
    id: "inc.r32"
  },
  {
    name: "dec ebx",
    bytes: [0x4b],
    mnemonic: "dec",
    operands: [reg32("ebx")],
    id: "dec.r32"
  },
  {
    name: "inc [eax]",
    bytes: [0xff, 0x00],
    mnemonic: "inc",
    operands: [mem32({ base: "eax", scale: 1, disp: 0 })],
    id: "inc.rm32"
  },
  {
    name: "dec [ecx]",
    bytes: [0xff, 0x09],
    mnemonic: "dec",
    operands: [mem32({ base: "ecx", scale: 1, disp: 0 })],
    id: "dec.rm32"
  },
  {
    name: "not byte [eax]",
    bytes: [0xf6, 0x10],
    mnemonic: "not",
    operands: [mem(8, { base: "eax", scale: 1, disp: 0 })],
    id: "not.rm8"
  },
  {
    name: "neg bl",
    bytes: [0xf6, 0xdb],
    mnemonic: "neg",
    operands: [reg("bl")],
    id: "neg.rm8"
  },
  {
    name: "not ax with operand-size override",
    bytes: [0x66, 0xf7, 0xd0],
    mnemonic: "not",
    operands: [reg("ax")],
    id: "not.rm16"
  },
  {
    name: "neg word [ebp-2] with operand-size override",
    bytes: [0x66, 0xf7, 0x5d, 0xfe],
    mnemonic: "neg",
    operands: [mem(16, { base: "ebp", scale: 1, disp: -2 })],
    id: "neg.rm16"
  },
  {
    name: "not eax",
    bytes: [0xf7, 0xd0],
    mnemonic: "not",
    operands: [reg32("eax")],
    id: "not.rm32"
  },
  {
    name: "neg [eax]",
    bytes: [0xf7, 0x18],
    mnemonic: "neg",
    operands: [mem32({ base: "eax", scale: 1, disp: 0 })],
    id: "neg.rm32"
  },
  {
    name: "group 81 add eax, imm32",
    bytes: [0x81, 0xc0, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "add",
    operands: [reg32("eax"), imm32(0x1234_5678)],
    id: "add.rm32_imm32"
  },
  {
    name: "group 81 or eax, imm32",
    bytes: [0x81, 0xc8, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "or",
    operands: [reg32("eax"), imm32(0x1234_5678)],
    id: "or.rm32_imm32"
  },
  {
    name: "group 81 and eax, imm32",
    bytes: [0x81, 0xe0, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "and",
    operands: [reg32("eax"), imm32(0x1234_5678)],
    id: "and.rm32_imm32"
  },
  {
    name: "group 81 sub eax, imm32",
    bytes: [0x81, 0xe8, 0x01, 0x00, 0x00, 0x00],
    mnemonic: "sub",
    operands: [reg32("eax"), imm32(1)],
    id: "sub.rm32_imm32"
  },
  {
    name: "group 81 cmp ecx, imm32",
    bytes: [0x81, 0xf9, 0x00, 0x00, 0x00, 0x00],
    mnemonic: "cmp",
    operands: [reg32("ecx"), imm32(0)],
    id: "cmp.rm32_imm32"
  },
  {
    name: "group 83 add eax, imm8",
    bytes: [0x83, 0xc0, 0xff],
    mnemonic: "add",
    operands: [reg32("eax"), signImm8(0xffff_ffff)],
    id: "add.rm32_imm8"
  },
  {
    name: "group 83 or eax, imm8",
    bytes: [0x83, 0xc8, 0xff],
    mnemonic: "or",
    operands: [reg32("eax"), signImm8(0xffff_ffff)],
    id: "or.rm32_imm8"
  },
  {
    name: "group 83 and eax, imm8",
    bytes: [0x83, 0xe0, 0x7f],
    mnemonic: "and",
    operands: [reg32("eax"), signImm8(0x7f)],
    id: "and.rm32_imm8"
  },
  {
    name: "group 83 sub eax, imm8",
    bytes: [0x83, 0xe8, 0x7f],
    mnemonic: "sub",
    operands: [reg32("eax"), signImm8(0x7f)],
    id: "sub.rm32_imm8"
  },
  {
    name: "group 83 cmp ecx, imm8",
    bytes: [0x83, 0xf9, 0x80],
    mnemonic: "cmp",
    operands: [reg32("ecx"), signImm8(0xffff_ff80)],
    id: "cmp.rm32_imm8"
  },
  {
    name: "add [eax], ebx",
    bytes: [0x01, 0x18],
    mnemonic: "add",
    operands: [mem32({ base: "eax", scale: 1, disp: 0 }), reg32("ebx")],
    id: "add.rm32_r32"
  },
  {
    name: "add ebx, [eax]",
    bytes: [0x03, 0x18],
    mnemonic: "add",
    operands: [reg32("ebx"), mem32({ base: "eax", scale: 1, disp: 0 })],
    id: "add.r32_rm32"
  },
  {
    name: "cmp [ebp-4], eax",
    bytes: [0x39, 0x45, 0xfc],
    mnemonic: "cmp",
    operands: [mem32({ base: "ebp", scale: 1, disp: -4 }), reg32("eax")],
    id: "cmp.rm32_r32"
  },
  {
    name: "test [0x00402000], eax",
    bytes: [0x85, 0x05, 0x00, 0x20, 0x40, 0x00],
    mnemonic: "test",
    operands: [mem32({ scale: 1, disp: 0x0040_2000 }), reg32("eax")],
    id: "test.rm32_r32"
  },
  {
    name: "add [0x20], imm8",
    bytes: [0x83, 0x05, 0x20, 0x00, 0x00, 0x00, 0xff],
    mnemonic: "add",
    operands: [
      mem32({ scale: 1, disp: 0x20 }),
      signImm8(0xffff_ffff)
    ],
    id: "add.rm32_imm8"
  },
  {
    name: "cmp [ebp-4], imm32",
    bytes: [0x81, 0x7d, 0xfc, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "cmp",
    operands: [
      mem32({ base: "ebp", scale: 1, disp: -4 }),
      imm32(0x1234_5678)
    ],
    id: "cmp.rm32_imm32"
  },
  {
    name: "cmp [ebp-4], imm16 with operand-size override",
    bytes: [0x66, 0x81, 0x7d, 0xfc, 0x34, 0x12],
    mnemonic: "cmp",
    operands: [
      mem(16, { base: "ebp", scale: 1, disp: -4 }),
      imm16(0x1234)
    ],
    id: "cmp.rm16_imm16"
  }
];

testDecodeFixtures(fixtures);
