import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
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
