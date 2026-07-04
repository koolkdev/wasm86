import { form, mnemonic } from "#x86/schema/builders.js";
import { opReg } from "#x86/schema/operands.js";
import { opcodePlusReg } from "#x86/schema/opcodes.js";
import { bswapSemantic } from "#x86/semantics/byte-swap.js";

export const BSWAP = mnemonic("bswap", [
  // 0F C8+rd: BSWAP r32
  form("r32", {
    opcode: [0x0f, opcodePlusReg(0xc8)],
    operands: [opReg()],
    syntax: "bswap {0}",
    semantics: bswapSemantic()
  })
]);
