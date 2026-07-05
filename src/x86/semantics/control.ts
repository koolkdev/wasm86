import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";
import { guardStorageRead } from "./memory.js";

export function jmpSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const target = s.operand(0);

    guardStorageRead(s, context, target, width);
    const value = s.get(target, width);

    s.jump(width === 16 ? s.truncate(16, value) : value);
  };
}

export function callSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const targetOperand = s.operand(0);

    guardStorageRead(s, context, targetOperand, width);
    const target = s.get(targetOperand, width);

    pushStack(s, context, width, s.nextEip());
    s.jump(width === 16 ? s.truncate(16, target) : target);
  };
}

export function retSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const target = popStack(s, context, width);

    s.jump(width === 16 ? s.truncate(16, target) : target);
  };
}

export function retImmSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const target = popStack(s, context, width);
    const bytes = s.get(s.operand(0));
    const esp = s.get(s.reg("esp"));
    const adjustedEsp = s.binary("add", esp, bytes);

    s.set(s.reg("esp"), adjustedEsp);
    s.jump(width === 16 ? s.truncate(16, target) : target);
  };
}

export function jccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s) => {
    s.conditionalJump(s.condition(cc), s.get(s.operand(0)), s.nextEip());
  };
}

export function jecxzSemantic(): SemanticTemplate {
  return (s) => {
    const ecx = s.get(s.reg("ecx"));

    s.conditionalJump(s.compare(32, "eq", ecx, s.const32(0)), s.get(s.operand(0)), s.nextEip());
  };
}

export type LoopCondition = "none" | "E" | "NE";

export function loopSemantic(condition: LoopCondition): SemanticTemplate {
  return (s) => {
    const decremented = s.binary("sub", s.get(s.reg("ecx")), s.const32(1));
    const nonzero = s.compare(32, "ne", decremented, s.const32(0));

    s.set(s.reg("ecx"), decremented);
    s.conditionalJump(loopBranchPredicate(s, condition, nonzero), s.get(s.operand(0)), s.nextEip());
  };
}

function loopBranchPredicate(
  s: SemanticsBuilder,
  condition: LoopCondition,
  nonzero: Value
): Value {
  switch (condition) {
    case "none":
      return nonzero;
    case "E":
    case "NE":
      return s.binary("and", nonzero, s.condition(condition));
  }
}
