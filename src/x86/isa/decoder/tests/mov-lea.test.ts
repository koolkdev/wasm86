import { imm32, mem, mem32, reg, reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "mov al, [ebx]",
    bytes: [0x8a, 0x03],
    mnemonic: "mov",
    operands: [reg("al"), mem(8, { base: "ebx", scale: 1, disp: 0 })],
    id: "mov.r8_rm8"
  },
  {
    name: "mov ax, [ebx] with operand-size override",
    bytes: [0x66, 0x8b, 0x03],
    mnemonic: "mov",
    operands: [reg("ax"), mem(16, { base: "ebx", scale: 1, disp: 0 })],
    id: "mov.r16_rm16"
  },
  {
    name: "mov eax, imm32",
    bytes: [0xb8, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "mov",
    operands: [reg32("eax"), imm32(0x1234_5678)],
    id: "mov.r32_imm32"
  },
  {
    name: "mov ecx, imm32",
    bytes: [0xb9, 0x01, 0x00, 0x00, 0x00],
    mnemonic: "mov",
    operands: [reg32("ecx"), imm32(1)],
    id: "mov.r32_imm32"
  },
  {
    name: "mov edi, imm32",
    bytes: [0xbf, 0xff, 0xff, 0xff, 0xff],
    mnemonic: "mov",
    operands: [reg32("edi"), imm32(0xffff_ffff)],
    id: "mov.r32_imm32"
  },
  {
    name: "mov eax, imm32 through C7 group",
    bytes: [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "mov",
    operands: [reg32("eax"), imm32(0x1234_5678)],
    id: "mov.rm32_imm32"
  },
  {
    name: "register mov eax, ebx",
    bytes: [0x89, 0xd8],
    mnemonic: "mov",
    operands: [reg32("eax"), reg32("ebx")],
    id: "mov.rm32_r32"
  },
  {
    name: "register mov ebx, eax",
    bytes: [0x8b, 0xd8],
    mnemonic: "mov",
    operands: [reg32("ebx"), reg32("eax")],
    id: "mov.r32_rm32"
  },
  {
    name: "register mov ebp, esp",
    bytes: [0x89, 0xe5],
    mnemonic: "mov",
    operands: [reg32("ebp"), reg32("esp")],
    id: "mov.rm32_r32"
  },
  {
    name: "mov eax, [ebx]",
    bytes: [0x8b, 0x03],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "ebx", scale: 1, disp: 0 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [ebx+4]",
    bytes: [0x8b, 0x43, 0x04],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "ebx", scale: 1, disp: 4 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [ebx+0x12345678]",
    bytes: [0x8b, 0x83, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "ebx", scale: 1, disp: 0x1234_5678 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [0x00402000]",
    bytes: [0x8b, 0x05, 0x00, 0x20, 0x40, 0x00],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ scale: 1, disp: 0x0040_2000 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov [ebp-4], eax",
    bytes: [0x89, 0x45, 0xfc],
    mnemonic: "mov",
    operands: [mem32({ base: "ebp", scale: 1, disp: -4 }), reg32("eax")],
    id: "mov.rm32_r32"
  },
  {
    name: "mov [ebp-4], imm32 through C7 group",
    bytes: [0xc7, 0x45, 0xfc, 0x78, 0x56, 0x34, 0x12],
    mnemonic: "mov",
    operands: [mem32({ base: "ebp", scale: 1, disp: -4 }), imm32(0x1234_5678)],
    id: "mov.rm32_imm32"
  },
  {
    name: "mov eax, [eax + ecx*4]",
    bytes: [0x8b, 0x04, 0x88],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "eax", index: "ecx", scale: 4, disp: 0 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [ebx + ecx*4 + 0x10]",
    bytes: [0x8b, 0x44, 0x8b, 0x10],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "ebx", index: "ecx", scale: 4, disp: 0x10 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [ecx*4 + 0x00402000]",
    bytes: [0x8b, 0x04, 0x8d, 0x00, 0x20, 0x40, 0x00],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ index: "ecx", scale: 4, disp: 0x0040_2000 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [esp]",
    bytes: [0x8b, 0x04, 0x24],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "esp", scale: 1, disp: 0 })],
    id: "mov.r32_rm32"
  },
  {
    name: "mov eax, [esp + 4]",
    bytes: [0x8b, 0x44, 0x24, 0x04],
    mnemonic: "mov",
    operands: [reg32("eax"), mem32({ base: "esp", scale: 1, disp: 4 })],
    id: "mov.r32_rm32"
  },
  {
    name: "movzx eax, bl",
    bytes: [0x0f, 0xb6, 0xc3],
    mnemonic: "movzx",
    operands: [reg32("eax"), reg("bl")],
    id: "movzx.r32_rm8"
  },
  {
    name: "movzx ax, ah with operand-size override",
    bytes: [0x66, 0x0f, 0xb6, 0xc4],
    mnemonic: "movzx",
    operands: [reg("ax"), reg("ah")],
    id: "movzx.r16_rm8"
  },
  {
    name: "movzx eax, word [ebx]",
    bytes: [0x0f, 0xb7, 0x03],
    mnemonic: "movzx",
    operands: [reg32("eax"), mem(16, { base: "ebx", scale: 1, disp: 0 })],
    id: "movzx.r32_rm16"
  },
  {
    name: "movsx eax, ah",
    bytes: [0x0f, 0xbe, 0xc4],
    mnemonic: "movsx",
    operands: [reg32("eax"), reg("ah")],
    id: "movsx.r32_rm8"
  },
  {
    name: "movsx ax, bl with operand-size override",
    bytes: [0x66, 0x0f, 0xbe, 0xc3],
    mnemonic: "movsx",
    operands: [reg("ax"), reg("bl")],
    id: "movsx.r16_rm8"
  },
  {
    name: "movsx eax, word [ebx]",
    bytes: [0x0f, 0xbf, 0x03],
    mnemonic: "movsx",
    operands: [reg32("eax"), mem(16, { base: "ebx", scale: 1, disp: 0 })],
    id: "movsx.r32_rm16"
  },
  {
    name: "mov [esp - 4], ecx",
    bytes: [0x89, 0x4c, 0x24, 0xfc],
    mnemonic: "mov",
    operands: [mem32({ base: "esp", scale: 1, disp: -4 }), reg32("ecx")],
    id: "mov.rm32_r32"
  },
  {
    name: "cmove edx, ecx",
    bytes: [0x0f, 0x44, 0xd1],
    mnemonic: "cmove",
    operands: [reg32("edx"), reg32("ecx")],
    id: "cmove.r32_rm32"
  },
  {
    name: "cmove dx, cx with operand-size override",
    bytes: [0x66, 0x0f, 0x44, 0xd1],
    mnemonic: "cmove",
    operands: [reg("dx"), reg("cx")],
    id: "cmove.r16_rm16"
  },
  {
    name: "cmovne edx, [ebx]",
    bytes: [0x0f, 0x45, 0x13],
    mnemonic: "cmovne",
    operands: [reg32("edx"), mem32({ base: "ebx", scale: 1, disp: 0 })],
    id: "cmovne.r32_rm32"
  },
  {
    name: "lea eax, [ebx + ecx*4 + 0x10]",
    bytes: [0x8d, 0x44, 0x8b, 0x10],
    mnemonic: "lea",
    operands: [reg32("eax"), mem32({ base: "ebx", index: "ecx", scale: 4, disp: 0x10 })],
    id: "lea.r32_m32"
  },
  {
    name: "lea ax, [ebx + ecx*4 + 0x10] with operand-size override",
    bytes: [0x66, 0x8d, 0x44, 0x8b, 0x10],
    mnemonic: "lea",
    operands: [reg("ax"), mem(16, { base: "ebx", index: "ecx", scale: 4, disp: 0x10 })],
    id: "lea.r16_m16"
  },
  {
    name: "lea eax, [ecx*4 + 0x00402000]",
    bytes: [0x8d, 0x04, 0x8d, 0x00, 0x20, 0x40, 0x00],
    mnemonic: "lea",
    operands: [reg32("eax"), mem32({ index: "ecx", scale: 4, disp: 0x0040_2000 })],
    id: "lea.r32_m32"
  }
];

testDecodeFixtures(fixtures);
