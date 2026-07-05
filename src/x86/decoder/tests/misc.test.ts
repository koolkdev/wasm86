import { mem, testDecodeFixtures } from "./helpers.js";

testDecodeFixtures([
  {
    name: "XLAT",
    bytes: [0xd7],
    mnemonic: "xlat",
    operands: [mem(8, { base: "ebx", scale: 1, disp: 0 })],
    id: "xlat.m8_al",
    format: "xlat"
  },
  {
    name: "XLAT with FS override",
    bytes: [0x64, 0xd7],
    mnemonic: "xlat",
    operands: [mem(8, { segment: "fs", base: "ebx", scale: 1, disp: 0 })],
    id: "xlat.m8_al",
    format: "xlat"
  },
  {
    name: "WAIT/FWAIT",
    bytes: [0x9b],
    mnemonic: "wait",
    id: "wait.near"
  }
]);
