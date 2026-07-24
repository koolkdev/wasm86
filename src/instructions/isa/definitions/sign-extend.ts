import { form, mnemonic } from "../dsl.js";
import {
  accumulatorSignExtendSemantic,
  highAccumulatorSignExtendSemantic
} from "#instructions/semantics/sign-extend.js";

export const CBW = mnemonic("cbw", [
  // 66 98: CBW
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x98],
    syntax: "cbw",
    semantics: accumulatorSignExtendSemantic(8)
  })
]);

export const CWDE = mnemonic("cwde", [
  // 98: CWDE
  form("dword", {
    opcode: [0x98],
    syntax: "cwde",
    semantics: accumulatorSignExtendSemantic(16)
  })
]);

export const CWD = mnemonic("cwd", [
  // 66 99: CWD
  form("word", {
    prefixes: { operandSize: "override" },
    opcode: [0x99],
    syntax: "cwd",
    semantics: highAccumulatorSignExtendSemantic(16)
  })
]);

export const CDQ = mnemonic("cdq", [
  // 99: CDQ
  form("dword", {
    opcode: [0x99],
    syntax: "cdq",
    semantics: highAccumulatorSignExtendSemantic(32)
  })
]);
