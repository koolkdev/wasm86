import { reg32, testDecodeFixtures, type DecoderFixture } from "./helpers.js";

const fixtures: readonly DecoderFixture[] = [
  {
    name: "bswap eax",
    bytes: [0x0f, 0xc8],
    mnemonic: "bswap",
    operands: [reg32("eax")],
    id: "bswap.r32"
  },
  {
    name: "bswap edi",
    bytes: [0x0f, 0xcf],
    mnemonic: "bswap",
    operands: [reg32("edi")],
    id: "bswap.r32"
  }
];

testDecodeFixtures(fixtures);
