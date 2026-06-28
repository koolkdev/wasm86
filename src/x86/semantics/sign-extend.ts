import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";

export function accumulatorSignExtendSemantic(width: Extract<OperandWidth, 8 | 16>): SemanticTemplate {
  return (s) => {
    switch (width) {
      case 8:
        s.set(s.reg("ax"), s.get(s.reg("al"), 8, { signed: true }), 16);
        return;
      case 16:
        s.set(s.reg("eax"), s.get(s.reg("ax"), 16, { signed: true }), 32);
        return;
    }
  };
}

export function highAccumulatorSignExtendSemantic(width: Extract<OperandWidth, 16 | 32>): SemanticTemplate {
  return (s) => {
    switch (width) {
      case 16:
        s.set(
          s.reg("dx"),
          s.project(16, s.binary("shr_s", s.get(s.reg("ax"), 16, { signed: true }), s.const32(15))),
          16
        );
        return;
      case 32:
        s.set(s.reg("edx"), s.binary("shr_s", s.get(s.reg("eax"), 32), s.const32(31)), 32);
        return;
    }
  };
}
