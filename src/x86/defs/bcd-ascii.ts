import { form, mnemonic } from "#x86/schema/builders.js";
import { imm } from "#x86/schema/operands.js";
import {
  aaaSemantic,
  aadSemantic,
  aamSemantic,
  aasSemantic,
  daaSemantic,
  dasSemantic
} from "#x86/semantics/bcd-ascii.js";

export const DAA = mnemonic("daa", [
  // 27: DAA
  form("al", {
    opcode: [0x27],
    format: { syntax: "daa" },
    semantics: daaSemantic()
  })
]);

export const DAS = mnemonic("das", [
  // 2F: DAS
  form("al", {
    opcode: [0x2f],
    format: { syntax: "das" },
    semantics: dasSemantic()
  })
]);

export const AAA = mnemonic("aaa", [
  // 37: AAA
  form("al_ah", {
    opcode: [0x37],
    format: { syntax: "aaa" },
    semantics: aaaSemantic()
  })
]);

export const AAS = mnemonic("aas", [
  // 3F: AAS
  form("al_ah", {
    opcode: [0x3f],
    format: { syntax: "aas" },
    semantics: aasSemantic()
  })
]);

export const AAM = mnemonic("aam", [
  // D4 ib: AAM imm8
  form("imm8", {
    opcode: [0xd4],
    operands: [imm(8)],
    format: { syntax: "aam {0}" },
    semantics: aamSemantic()
  })
]);

export const AAD = mnemonic("aad", [
  // D5 ib: AAD imm8
  form("imm8", {
    opcode: [0xd5],
    operands: [imm(8)],
    format: { syntax: "aad {0}" },
    semantics: aadSemantic()
  })
]);
