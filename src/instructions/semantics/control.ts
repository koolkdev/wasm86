import type { ConditionCode } from "#core/flags/conditions.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticsBuilder,
  SemanticTemplate
} from "#instructions/semantics/builder.js";
import type { Value } from "#instructions/semantics/refs.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";

export function jmpSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const target = s.operand(0);
    const value = s.read(target, { width });

    s.jump(width === 16 ? v.truncate(16, value) : value);
  };
}

export function callSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const targetOperand = s.operand(0);
    const target = s.read(targetOperand, { width });

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
    const bytes = s.read(s.operand(0), { width: 32 });
    const esp = s.read(s.reg("esp"), { width: 32 });
    const adjustedEsp = v.binary("add", esp, bytes);

    s.write(s.reg("esp"), adjustedEsp, { width: 32 });
    s.jump(width === 16 ? v.truncate(16, target) : target);
  };
}

export function enterSemantic(): SemanticTemplate {
  return (s, v) => {
    const size = s.read(s.operand(0), { width: 32 });
    const level = v.binary("and", s.read(s.operand(1), { width: 32 }), v.const(31));
    const esp = s.read(s.reg("esp"), { width: 32 });
    const ebp = s.read(s.reg("ebp"), { width: 32 });
    const levelIsZero = v.compare(32, "eq", level, v.const(0));
    const levelGtZero = v.compare(32, "gt_u", level, v.const(0));
    const levelGtOne = v.compare(32, "gt_u", level, v.const(1));
    const frameTemp = v.binary("sub", esp, v.const(4));
    const writeSlots = v.select(levelIsZero, v.const(1), v.binary("add", level, v.const(1)));
    const writeBytes = v.binary("shl", writeSlots, v.const(2));
    const writeStart = v.binary("sub", esp, writeBytes);
    const oldFrameOffset = v.binary("sub", frameTemp, writeStart);
    const writeAccess = s.memory.guard({
      reference: s.memory.reference("ss", writeStart),
      byteLength: writeBytes,
      intent: "write"
    });

    s.ifElse(
      levelGtOne,
      (then, thenValues) => {
        const readBytes = thenValues.binary(
          "shl",
          thenValues.binary("sub", level, thenValues.const(1)),
          thenValues.const(2)
        );
        const readStart = thenValues.binary("sub", ebp, readBytes);
        const readAccess = then.memory.guard({
          reference: then.memory.reference("ss", readStart),
          byteLength: readBytes,
          intent: "read"
        });

        then.memory.store(writeAccess, {
          width: 32,
          byteOffset: oldFrameOffset,
          value: ebp
        });
        const remaining = then.var(thenValues.binary("sub", level, thenValues.const(1)));
        const srcOffset = then.var(thenValues.binary("sub", readBytes, thenValues.const(4)));
        const dstOffset = then.var(thenValues.binary("sub", oldFrameOffset, thenValues.const(4)));

        then.loop((loop, loopValues) => {
          const currentRemaining = loop.read(remaining, { width: 32 });
          const currentSrcOffset = loop.read(srcOffset, { width: 32 });
          const currentDstOffset = loop.read(dstOffset, { width: 32 });
          const copied = loop.memory.load(readAccess, {
            width: 32,
            byteOffset: currentSrcOffset
          });
          const nextRemaining = loopValues.binary("sub", currentRemaining, loopValues.const(1));

          loop.memory.store(writeAccess, {
            width: 32,
            byteOffset: currentDstOffset,
            value: copied
          });
          loop.write(remaining, nextRemaining, { width: 32 });
          loop.write(srcOffset, loopValues.binary("sub", currentSrcOffset, loopValues.const(4)), { width: 32 });
          loop.write(dstOffset, loopValues.binary("sub", currentDstOffset, loopValues.const(4)), { width: 32 });
          return loopValues.compare(32, "ne", nextRemaining, loopValues.const(0));
        });
        then.memory.store(writeAccess, { width: 32, value: frameTemp });
      },
      (otherwise) => {
        otherwise.memory.store(writeAccess, {
          width: 32,
          byteOffset: oldFrameOffset,
          value: ebp
        });
        otherwise.if(levelGtZero, (nonzero) => {
          nonzero.memory.store(writeAccess, { width: 32, value: frameTemp });
        });
      }
    );
    s.write(s.reg("ebp"), frameTemp, { width: 32 });
    s.write(s.reg("esp"), v.binary("sub", writeStart, size), { width: 32 });
  };
}

export function jccSemantic(cc: ConditionCode): SemanticTemplate {
  return (s) => {
    const branch = s.condition(cc);
    const target = s.read(s.operand(0), { width: 32 });

    s.if(branch, (then) => then.jump(target));
  };
}

export function jecxzSemantic(): SemanticTemplate {
  return (s, v) => {
    const ecx = s.read(s.reg("ecx"), { width: 32 });
    const branch = v.compare(32, "eq", ecx, v.const(0));
    const target = s.read(s.operand(0), { width: 32 });

    s.if(branch, (then) => then.jump(target));
  };
}

export type LoopCondition = "none" | "E" | "NE";

export function loopSemantic(condition: LoopCondition): SemanticTemplate {
  return (s, v) => {
    const decremented = v.binary("sub", s.read(s.reg("ecx"), { width: 32 }), v.const(1));
    const nonzero = v.compare(32, "ne", decremented, v.const(0));

    s.write(s.reg("ecx"), decremented, { width: 32 });
    const branch = loopBranchPredicate(s, v, condition, nonzero);
    const target = s.read(s.operand(0), { width: 32 });

    s.if(branch, (then) => then.jump(target));
  };
}

function loopBranchPredicate(
  s: SemanticsBuilder,
  v: ValueBuilder,
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
