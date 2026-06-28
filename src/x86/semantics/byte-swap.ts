import type { SemanticTemplate } from "#x86/semantics/builder.js";

export function bswapSemantic(): SemanticTemplate {
  return (s) => {
    const dst = s.operand(0);
    const value = s.get(dst, 32);
    const lowPairs = s.binary("and", value, s.const32(0x00ff_00ff));
    const highPairs = s.binary("and", value, s.const32(0xff00_ff00));
    const result = s.binary(
      "or",
      s.binary("rotr", lowPairs, s.const32(8)),
      s.binary("rotl", highPairs, s.const32(8))
    );

    s.set(dst, result, 32);
  };
}
