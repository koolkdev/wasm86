import type { ConditionCode } from "#core/flags/conditions.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import { popStack, pushStack, type StackOperandWidth } from "./stack.js";

export function jmpSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const target = s.read(s.operand(0), width);

    s.jump(target.unsigned.extend(32));
  };
}

export function callSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const target = s.read(s.operand(0), width);

    pushStack(s, s.nextEip().truncate(width));
    s.jump(target.unsigned.extend(32));
  };
}

export function retSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const target = popStack(s, width);

    s.jump(target.unsigned.extend(32));
  };
}

export function retImmSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const target = popStack(s, width);
    const bytes = s.read(s.operand(0), 32);
    const esp = s.read(s.reg("esp"));
    const adjustedEsp = esp.add(bytes);

    s.write(s.reg("esp"), adjustedEsp);
    s.jump(target.unsigned.extend(32));
  };
}

export function enterSemantic(): InstructionSemantics {
  return (s) => {
    const size = s.read(s.operand(0), 32);
    const level = s.read(s.operand(1), 32).and(31);
    const esp = s.read(s.reg("esp"));
    const ebp = s.read(s.reg("ebp"));
    const levelGtZero = level.unsigned.gt(0);
    const levelGtOne = level.unsigned.gt(1);
    const frameTemp = esp.sub(4);
    const writeSlots = level.add(1);
    const writeBytes = writeSlots.shl(2);
    const writeStart = esp.sub(writeBytes);
    const oldFrameOffset = frameTemp.sub(writeStart);
    const writeAccess = s.memory.guard({
      reference: s.memory.reference("ss", writeStart),
      byteLength: writeBytes,
      intent: "write"
    });

    s.ifElse(
      levelGtOne,
      (then) => {
        const readBytes = level.sub(1).shl(2);
        const readStart = ebp.sub(readBytes);
        const readAccess = then.memory.guard({
          reference: then.memory.reference("ss", readStart),
          byteLength: readBytes,
          intent: "read"
        });

        then.memory.store(writeAccess, ebp, oldFrameOffset);
        const remaining = then.var(level.sub(1));
        const srcOffset = then.var(readBytes.sub(4));
        const dstOffset = then.var(oldFrameOffset.sub(4));

        then.loop((loop) => {
          const currentRemaining = loop.read(remaining);
          const currentSrcOffset = loop.read(srcOffset);
          const currentDstOffset = loop.read(dstOffset);
          const copied = loop.memory.load(readAccess, 32, currentSrcOffset);
          const nextRemaining = currentRemaining.sub(1);

          loop.memory.store(writeAccess, copied, currentDstOffset);
          loop.write(remaining, nextRemaining);
          loop.write(srcOffset, currentSrcOffset.sub(4));
          loop.write(dstOffset, currentDstOffset.sub(4));
          return nextRemaining.ne(0);
        });
        then.memory.store(writeAccess, frameTemp);
      },
      (otherwise) => {
        otherwise.memory.store(writeAccess, ebp, oldFrameOffset);
        otherwise.if(levelGtZero, (nonzero) => {
          nonzero.memory.store(writeAccess, frameTemp);
        });
      }
    );
    s.write(s.reg("ebp"), frameTemp);
    s.write(s.reg("esp"), writeStart.sub(size));
  };
}

export function jccSemantic(cc: ConditionCode): InstructionSemantics {
  return (s) => {
    const branch = s.condition(cc);
    const target = s.read(s.operand(0), 32);

    s.if(branch, (then) => then.jump(target));
  };
}

export function jecxzSemantic(): InstructionSemantics {
  return (s) => {
    const ecx = s.read(s.reg("ecx"));
    const branch = ecx.eq(0);
    const target = s.read(s.operand(0), 32);

    s.if(branch, (then) => then.jump(target));
  };
}

export type LoopCondition = "none" | "E" | "NE";

export function loopSemantic(condition: LoopCondition): InstructionSemantics {
  return (s) => {
    const decremented = s.read(s.reg("ecx")).sub(1);
    const nonzero = decremented.ne(0);

    s.write(s.reg("ecx"), decremented);
    const branch = condition === "none" ? nonzero : nonzero.and(s.condition(condition));
    const target = s.read(s.operand(0), 32);

    s.if(branch, (then) => then.jump(target));
  };
}
