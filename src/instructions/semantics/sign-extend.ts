import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";

export function accumulatorSignExtendSemantic(
  width: Extract<OperandWidth, 8 | 16>
): InstructionSemantics {
  return (s) => {
    switch (width) {
      case 8:
        s.write(s.reg("ax"), s.read(s.reg("al")).signed.extend(16));
        return;
      case 16:
        s.write(s.reg("eax"), s.read(s.reg("ax")).signed.extend(32));
        return;
    }
  };
}

export function highAccumulatorSignExtendSemantic(
  width: Extract<OperandWidth, 16 | 32>
): InstructionSemantics {
  return (s) => {
    switch (width) {
      case 16:
        s.write(s.reg("dx"), s.read(s.reg("ax")).signed.shr(15));
        return;
      case 32:
        s.write(s.reg("edx"), s.read(s.reg("eax")).signed.shr(31));
        return;
    }
  };
}
