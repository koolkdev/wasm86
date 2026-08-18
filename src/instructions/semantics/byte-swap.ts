import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function bswapSemantic(): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const value = s.read(dst, 32);
    const lowPairs = value.and(0x00ff_00ff);
    const highPairs = value.and(0xff00_ff00);
    const result = lowPairs.rotr(8).or(highPairs.rotl(8));

    s.write(dst, result);
  };
}
