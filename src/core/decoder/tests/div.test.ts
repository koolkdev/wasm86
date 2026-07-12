import {
  mem,
  mem32,
  reg,
  reg32,
  testDecodeFixtures,
  type DecoderFixture
} from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "div bl",
    bytes: [0xf6, 0xf3],
    mnemonic: "div",
    operands: [reg("bl")],
    id: "div.rm8",
    format: "div {0}"
  },
  {
    name: "div bx with operand-size override",
    bytes: [0x66, 0xf7, 0xf3],
    mnemonic: "div",
    operands: [reg("bx")],
    id: "div.rm16"
  },
  {
    name: "div ebx",
    bytes: [0xf7, 0xf3],
    mnemonic: "div",
    operands: [reg32("ebx")],
    id: "div.rm32"
  },
  {
    name: "div dword [ebx]",
    bytes: [0xf7, 0x33],
    mnemonic: "div",
    operands: [mem32({ base: "ebx", scale: 1, disp: 0 })],
    id: "div.rm32"
  },
  {
    name: "idiv bl",
    bytes: [0xf6, 0xfb],
    mnemonic: "idiv",
    operands: [reg("bl")],
    id: "idiv.rm8",
    format: "idiv {0}"
  },
  {
    name: "idiv bx with operand-size override",
    bytes: [0x66, 0xf7, 0xfb],
    mnemonic: "idiv",
    operands: [reg("bx")],
    id: "idiv.rm16"
  },
  {
    name: "idiv ebx",
    bytes: [0xf7, 0xfb],
    mnemonic: "idiv",
    operands: [reg32("ebx")],
    id: "idiv.rm32"
  },
  {
    name: "idiv byte [ebx]",
    bytes: [0xf6, 0x3b],
    mnemonic: "idiv",
    operands: [mem(8, { base: "ebx", scale: 1, disp: 0 })],
    id: "idiv.rm8"
  }
];

testDecodeFixtures(fixtures);
