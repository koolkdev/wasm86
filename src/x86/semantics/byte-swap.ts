import type { SemanticTemplate } from "#x86/semantics/builder.js";

export function bswapSemantic(): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const value = s.get(dst, 32);
    const lowPairs = v.binary("and", value, v.const(0x00ff_00ff));
    const highPairs = v.binary("and", value, v.const(0xff00_ff00));
    const result = v.binary(
      "or",
      v.binary("rotr", lowPairs, v.const(8)),
      v.binary("rotl", highPairs, v.const(8))
    );

    s.set(dst, result, 32);
  };
}
