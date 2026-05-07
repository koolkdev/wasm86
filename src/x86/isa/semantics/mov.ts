import type { ConditionCode, SemanticTemplate } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export function movSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s) => {
    s.set(s.operand(0), s.get(s.operand(1), width), width);
  };
}

export function movzxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s) => {
    s.set(s.operand(0), s.get(s.operand(1), sourceWidth), destinationWidth);
  };
}

export function movsxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s) => {
    s.set(s.operand(0), s.get(s.operand(1), sourceWidth, { signed: true }), destinationWidth);
  };
}

export function cmovSemantic(cc: ConditionCode, width: OperandWidth = 32): SemanticTemplate {
  return (s) => {
    const value = s.get(s.operand(1), width);
    const condition = s.condition(cc);
    const fallback = s.get(s.operand(0), width);
    const selected = s.i32Select(condition, value, fallback);

    s.set(s.operand(0), selected, width);
  };
}
