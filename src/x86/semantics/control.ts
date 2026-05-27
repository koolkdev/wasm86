import type { ConditionCode, SemanticTemplate } from "#ir/model/types.js";
import { pop32, push32 } from "./stack.js";
import { guardStorageRead } from "./memory.js";

export function jmpSemantic(): SemanticTemplate {
  return (s, context) => {
    const target = s.operand(0);

    guardStorageRead(s, context, target, 32);
    s.jump(s.get(target));
  };
}

export function callSemantic(): SemanticTemplate {
  return (s, context) => {
    const targetOperand = s.operand(0);

    guardStorageRead(s, context, targetOperand, 32);
    const target = s.get(targetOperand);

    push32(s, context, s.nextEip());
    s.jump(target);
  };
}

export function retSemantic(): SemanticTemplate {
  return (s, context) => {
    s.jump(pop32(s, context));
  };
}

export function retImmSemantic(): SemanticTemplate {
  return (s, context) => {
    const target = pop32(s, context);
    const bytes = s.get(s.operand(0));
    const esp = s.get(s.reg("esp"));
    const adjustedEsp = s.i32Add(esp, bytes);

    s.set(s.reg("esp"), adjustedEsp);
    s.jump(target);
  };
}

export function jccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s) => {
    s.conditionalJump(s.condition(cc), s.get(s.operand(0)), s.nextEip());
  };
}
