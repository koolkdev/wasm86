import { form, implicitMem, mnemonic } from "../dsl.js";
import {
  cmcSemantic,
  lahfSemantic,
  sahfSemantic,
  writeFlagSemantic,
  xlatSemantic
} from "#instructions/semantics/flags.js";

export const CLC = mnemonic("clc", [
  // F8: CLC
  form("near", {
    opcode: [0xf8],
    syntax: "clc",
    semantics: writeFlagSemantic("CF", 0)
  })
]);

export const STC = mnemonic("stc", [
  // F9: STC
  form("near", {
    opcode: [0xf9],
    syntax: "stc",
    semantics: writeFlagSemantic("CF", 1)
  })
]);

export const CMC = mnemonic("cmc", [
  // F5: CMC
  form("near", {
    opcode: [0xf5],
    syntax: "cmc",
    semantics: cmcSemantic()
  })
]);

export const CLD = mnemonic("cld", [
  // FC: CLD
  form("near", {
    opcode: [0xfc],
    syntax: "cld",
    semantics: writeFlagSemantic("DF", 0)
  })
]);

export const STD = mnemonic("std", [
  // FD: STD
  form("near", {
    opcode: [0xfd],
    syntax: "std",
    semantics: writeFlagSemantic("DF", 1)
  })
]);

export const LAHF = mnemonic("lahf", [
  // 9F: LAHF
  form("ah", {
    opcode: [0x9f],
    syntax: "lahf",
    semantics: lahfSemantic()
  })
]);

export const SAHF = mnemonic("sahf", [
  // 9E: SAHF
  form("ah", {
    opcode: [0x9e],
    syntax: "sahf",
    semantics: sahfSemantic()
  })
]);

export const XLAT = mnemonic("xlat", [
  // D7: XLATB, implicit byte table at DS:EBX with segment override honored.
  form("m8_al", {
    opcode: [0xd7],
    operands: [implicitMem(8, "ebx")],
    syntax: "xlat",
    semantics: xlatSemantic()
  })
]);
