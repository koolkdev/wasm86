import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";

export function accumulatorSignExtendSemantic(
  width: Extract<OperandWidth, 8 | 16>
): InstructionSemantics {
  return (s) => {
    switch (width) {
      case 8:
        s.write(s.reg("ax"), s.read(s.reg("al"), { width: 8, signed: true }), { width: 16 });
        return;
      case 16:
        s.write(s.reg("eax"), s.read(s.reg("ax"), { width: 16, signed: true }), { width: 32 });
        return;
    }
  };
}

export function highAccumulatorSignExtendSemantic(
  width: Extract<OperandWidth, 16 | 32>
): InstructionSemantics {
  return (s, v) => {
    switch (width) {
      case 16:
        s.write(
          s.reg("dx"),
          v.truncate(
            16,
            v.binary("shr_s", s.read(s.reg("ax"), { width: 16, signed: true }), v.const(15))
          ),
          { width: 16 }
        );
        return;
      case 32:
        s.write(s.reg("edx"), v.binary("shr_s", s.read(s.reg("eax"), { width: 32 }), v.const(31)), {
          width: 32
        });
        return;
    }
  };
}
