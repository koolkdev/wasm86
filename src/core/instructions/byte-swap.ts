import { form, mnemonic, opcodePlusReg, opReg } from "./dsl.js";
import { bswapSemantic } from "#core/semantics/byte-swap.js";

export const BSWAP = mnemonic("bswap", [
  // 0F C8+rd: BSWAP r32
  form("r32", {
    opcode: [0x0f, opcodePlusReg(0xc8)],
    operands: [opReg()],
    syntax: "bswap {0}",
    semantics: bswapSemantic()
  })
]);
