import type { ConditionCode } from "#x86/conditions.js";
import type { Values } from "#ir/values.js";
import type { SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";
import { guardStorageRead } from "./memory.js";

export function jmpSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const target = s.operand(0);

    guardStorageRead(s, v, context, target, width);
    const value = s.get(target, width);

    s.jump(width === 16 ? v.truncate(16, value) : value);
  };
}

export function callSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const targetOperand = s.operand(0);

    guardStorageRead(s, v, context, targetOperand, width);
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

export function enterSemantic(): SemanticTemplate {
  return (s, v) => {
    const size = s.get(s.operand(0));
    const level = v.binary("and", s.get(s.operand(1)), v.const(31));
    const esp = s.get(s.reg("esp"));
    const ebp = s.get(s.reg("ebp"));
    const levelIsZero = v.compare(32, "eq", level, v.const(0));
    const levelGtZero = v.compare(32, "gt_u", level, v.const(0));
    const levelGtOne = v.compare(32, "gt_u", level, v.const(1));
    const frameTemp = v.binary("sub", esp, v.const(4));
    const writeSlots = v.select(levelIsZero, v.const(1), v.binary("add", level, v.const(1)));
    const writeBytes = v.binary("shl", writeSlots, v.const(2));
    const writeStart = v.binary("sub", esp, writeBytes);

    s.memoryGuard(writeStart, writeBytes, "write");
    s.if(levelGtOne, (then, thenValues) => {
      const readBytes = thenValues.binary("shl", thenValues.binary("sub", level, thenValues.const(1)), thenValues.const(2));
      const readStart = thenValues.binary("sub", ebp, readBytes);

      then.memoryGuard(readStart, readBytes, "read");
    });

    s.set(s.mem(frameTemp), ebp);
    s.if(levelGtOne, (then, thenValues) => {
      const remaining = then.var(thenValues.binary("sub", level, thenValues.const(1)));
      const src = then.var(thenValues.binary("sub", ebp, thenValues.const(4)));
      const dst = then.var(thenValues.binary("sub", frameTemp, thenValues.const(4)));

      then.loop((loop, loopValues) => {
        const currentRemaining = loop.get(remaining);
        const currentSrc = loop.get(src);
        const currentDst = loop.get(dst);
        const copied = loop.get(loop.mem(currentSrc));
        const nextRemaining = loopValues.binary("sub", currentRemaining, loopValues.const(1));

        loop.set(loop.mem(currentDst), copied);
        loop.set(remaining, nextRemaining);
        loop.set(src, loopValues.binary("sub", currentSrc, loopValues.const(4)));
        loop.set(dst, loopValues.binary("sub", currentDst, loopValues.const(4)));
        return loopValues.compare(32, "ne", nextRemaining, loopValues.const(0));
      });
    });
    s.if(levelGtZero, (then) => {
      then.set(then.mem(writeStart), frameTemp);
    });
    s.set(s.reg("ebp"), frameTemp);
    s.set(s.reg("esp"), v.binary("sub", writeStart, size));
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
