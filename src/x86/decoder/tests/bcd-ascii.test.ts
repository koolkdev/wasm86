import { imm8, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "daa",
    bytes: [0x27],
    mnemonic: "daa",
    id: "daa.al",
    format: "daa"
  },
  {
    name: "das",
    bytes: [0x2f],
    mnemonic: "das",
    id: "das.al",
    format: "das"
  },
  {
    name: "aaa",
    bytes: [0x37],
    mnemonic: "aaa",
    id: "aaa.al_ah",
    format: "aaa"
  },
  {
    name: "aas",
    bytes: [0x3f],
    mnemonic: "aas",
    id: "aas.al_ah",
    format: "aas"
  },
  {
    name: "aam imm8",
    bytes: [0xd4, 0x10],
    mnemonic: "aam",
    operands: [imm8(0x10)],
    id: "aam.imm8",
    format: "aam {0}"
  },
  {
    name: "aad imm8",
    bytes: [0xd5, 0x80],
    mnemonic: "aad",
    operands: [imm8(0x80)],
    id: "aad.imm8",
    format: "aad {0}"
  }
];

testDecodeFixtures(fixtures);
