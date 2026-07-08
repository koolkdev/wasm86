import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticsBuilder, SemanticTemplate, Values } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";
import { guardStorageRead } from "./memory.js";

export function jmpSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const target = s.operand(0);

    guardStorageRead(s, context, target, width);
    const value = s.get(target, width);

    s.jump(width === 16 ? v.truncate(16, value) : value);
  };
}

export function callSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const targetOperand = s.operand(0);

    guardStorageRead(s, context, targetOperand, width);
    const target = s.get(targetOperand, width);

    pushStack(s, v, context, width, s.nextEip());
    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function retSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const target = popStack(s, v, context, width);

    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function retImmSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const target = popStack(s, v, context, width);
    const bytes = s.get(s.operand(0));
    const esp = s.get(s.reg("esp"));
    const adjustedEsp = v.binary("add", esp, bytes);

    s.set(s.reg("esp"), adjustedEsp);
    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function jccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s) => {
    const branch = s.condition(cc);
    const target = s.get(s.operand(0));

    s.if(branch, (then) => then.jump(target));
  };
}

export function jecxzSemantic(): SemanticTemplate {
  return (s, v) => {
    const ecx = s.get(s.reg("ecx"));
    const branch = v.compare(32, "eq", ecx, v.const(0));
    const target = s.get(s.operand(0));

    s.if(branch, (then) => then.jump(target));
  };
}

export type LoopCondition = "none" | "E" | "NE";

export function loopSemantic(condition: LoopCondition): SemanticTemplate {
  return (s, v) => {
    const decremented = v.binary("sub", s.get(s.reg("ecx")), v.const(1));
    const nonzero = v.compare(32, "ne", decremented, v.const(0));

    s.set(s.reg("ecx"), decremented);
    const branch = loopBranchPredicate(s, v, condition, nonzero);
    const target = s.get(s.operand(0));

    s.if(branch, (then) => then.jump(target));
  };
}

function loopBranchPredicate(
  s: SemanticsBuilder,
  v: Values,
  condition: LoopCondition,
  nonzero: Value
): Value {
  switch (condition) {
    case "none":
      return nonzero;
    case "E":
    case "NE":
      return v.binary("and", nonzero, s.condition(condition));
  }
}
