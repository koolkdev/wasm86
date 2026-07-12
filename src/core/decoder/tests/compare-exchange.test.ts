import { mem, reg, reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "cmpxchg al, bl",
    bytes: [0x0f, 0xb0, 0xd8],
    mnemonic: "cmpxchg",
    operands: [reg("al"), reg("bl")],
    id: "cmpxchg.rm8_r8",
    format: "cmpxchg {0}, {1}"
  },
  {
    name: "cmpxchg word [ebx], dx with operand-size override",
    bytes: [0x66, 0x0f, 0xb1, 0x13],
    mnemonic: "cmpxchg",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), reg("dx")],
    id: "cmpxchg.rm16_r16"
  },
  {
    name: "cmpxchg dword [eax + 4], ecx",
    bytes: [0x0f, 0xb1, 0x48, 0x04],
    mnemonic: "cmpxchg",
    operands: [mem(32, { base: "eax", scale: 1, disp: 4 }), reg32("ecx")],
    id: "cmpxchg.rm32_r32"
  },
  {
    name: "xadd al, bl",
    bytes: [0x0f, 0xc0, 0xd8],
    mnemonic: "xadd",
    operands: [reg("al"), reg("bl")],
    id: "xadd.rm8_r8",
    format: "xadd {0}, {1}"
  },
  {
    name: "xadd word [ebx], dx with operand-size override",
    bytes: [0x66, 0x0f, 0xc1, 0x13],
    mnemonic: "xadd",
    operands: [mem(16, { base: "ebx", scale: 1, disp: 0 }), reg("dx")],
    id: "xadd.rm16_r16"
  },
  {
    name: "xadd dword [eax + 4], ecx",
    bytes: [0x0f, 0xc1, 0x48, 0x04],
    mnemonic: "xadd",
    operands: [mem(32, { base: "eax", scale: 1, disp: 4 }), reg32("ecx")],
    id: "xadd.rm32_r32"
  },
  {
    name: "cmpxchg8b qword [eax + 8]",
    bytes: [0x0f, 0xc7, 0x48, 0x08],
    mnemonic: "cmpxchg8b",
    operands: [mem(64, { base: "eax", scale: 1, disp: 8 })],
    id: "cmpxchg8b.m64",
    format: "cmpxchg8b {0}"
  }
];

testDecodeFixtures(fixtures);
