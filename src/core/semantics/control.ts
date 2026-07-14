import type { ConditionCode } from "#core/flags/conditions.js";
import type { Values } from "#ir/values.js";
import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#core/semantics/builder.js";
import type { Value } from "#core/semantics/refs.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";
import {
  readStorage,
  resolveMemoryAccess,
  resolveStorageRead
} from "./memory.js";

export function jmpSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const target = s.operand(0);

    const access = resolveStorageRead(s, v, context, target, width);
    const value = readStorage(s, v, access, width);

    s.jump(width === 16 ? v.truncate(16, value) : value);
  };
}

export function callSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const targetOperand = s.operand(0);

    const access = resolveStorageRead(s, v, context, targetOperand, width);
    const target = readStorage(s, v, access, width);

    pushStack(s, v, width, s.nextEip());
    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function retSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const target = popStack(s, v, width);

    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function retImmSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const target = popStack(s, v, width);
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
    const oldFrameOffset = v.binary("sub", frameTemp, writeStart);
    const writeAccess = resolveMemoryAccess(
      s,
      s.mem("ss", writeStart),
      writeBytes,
      "write"
    );

    s.ifElse(
      levelGtOne,
      (then, thenValues) => {
        const readBytes = thenValues.binary(
          "shl",
          thenValues.binary("sub", level, thenValues.const(1)),
          thenValues.const(2)
        );
        const readStart = thenValues.binary("sub", ebp, readBytes);
        const readAccess = resolveMemoryAccess(
          then,
          then.mem("ss", readStart),
          readBytes,
          "read"
        );

        then.memoryWrite(writeAccess, oldFrameOffset, ebp, 32);
        const remaining = then.var(thenValues.binary("sub", level, thenValues.const(1)));
        const srcOffset = then.var(thenValues.binary("sub", readBytes, thenValues.const(4)));
        const dstOffset = then.var(thenValues.binary("sub", oldFrameOffset, thenValues.const(4)));

        then.loop((loop, loopValues) => {
          const currentRemaining = loop.get(remaining);
          const currentSrcOffset = loop.get(srcOffset);
          const currentDstOffset = loop.get(dstOffset);
          const copied = loop.memoryRead(readAccess, currentSrcOffset, 32);
          const nextRemaining = loopValues.binary("sub", currentRemaining, loopValues.const(1));

          loop.memoryWrite(writeAccess, currentDstOffset, copied, 32);
          loop.set(remaining, nextRemaining);
          loop.set(srcOffset, loopValues.binary("sub", currentSrcOffset, loopValues.const(4)));
          loop.set(dstOffset, loopValues.binary("sub", currentDstOffset, loopValues.const(4)));
          return loopValues.compare(32, "ne", nextRemaining, loopValues.const(0));
        });
        then.memoryWrite(writeAccess, thenValues.const(0), frameTemp, 32);
      },
      (otherwise, otherwiseValues) => {
        otherwise.memoryWrite(writeAccess, oldFrameOffset, ebp, 32);
        otherwise.if(levelGtZero, (nonzero) => {
          nonzero.memoryWrite(writeAccess, otherwiseValues.const(0), frameTemp, 32);
        });
      }
    );
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
