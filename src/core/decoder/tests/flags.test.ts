import { testDecodeFixtures } from "./helpers.js";

testDecodeFixtures([
  {
    name: "CLC",
    bytes: [0xf8],
    mnemonic: "clc",
    id: "clc.near"
  },
  {
    name: "STC",
    bytes: [0xf9],
    mnemonic: "stc",
    id: "stc.near"
  },
  {
    name: "CMC",
    bytes: [0xf5],
    mnemonic: "cmc",
    id: "cmc.near"
  },
  {
    name: "CLD",
    bytes: [0xfc],
    mnemonic: "cld",
    id: "cld.near"
  },
  {
    name: "STD",
    bytes: [0xfd],
    mnemonic: "std",
    id: "std.near"
  },
  {
    name: "LAHF",
    bytes: [0x9f],
    mnemonic: "lahf",
    id: "lahf.ah"
  },
  {
    name: "SAHF",
    bytes: [0x9e],
    mnemonic: "sahf",
    id: "sahf.ah"
  }
]);
