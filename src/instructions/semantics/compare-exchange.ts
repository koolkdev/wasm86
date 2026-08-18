import { i32, select } from "#compiler/function/values.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { addFlagSource, subFlagSource } from "#core/flags/lazy/sources.js";
import { accumulator } from "./registers.js";

export function cmpxchgSemantic<Width extends OperandWidth>(width: Width): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const acc = accumulator(width);

    const destination = s.update(dst, width);
    const oldDst = s.read(destination);
    const oldSrc = s.read(src, width);
    const oldAcc = s.read(acc);
    const result = oldAcc.sub(oldDst);
    const equal = oldAcc.eq(oldDst);

    s.writeStatusFlagsSource(subFlagSource({ left: oldAcc, right: oldDst, result }));
    s.ifElse(
      equal,
      (then) => then.write(destination, oldSrc),
      (otherwise) => otherwise.write(acc, oldDst)
    );
  };
}

export function xaddSemantic<Width extends OperandWidth>(width: Width): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const destination = s.update(dst, width);
    const source = s.update(src, width);
    const oldDst = s.read(destination);
    const oldSrc = s.read(source);
    const result = oldDst.add(oldSrc);

    s.writeStatusFlagsSource(addFlagSource({ left: oldDst, right: oldSrc, result }));
    s.write(source, oldDst);
    s.write(destination, result);
  };
}

export function cmpxchg8bSemantic(): InstructionSemantics {
  return (s) => {
    const access = s.memory.guard({
      reference: s.memory.operand(s.operand(0)),
      byteLength: i32(8),
      intent: "write"
    });

    const oldLo = s.memory.load(access, 32);
    const oldHi = s.memory.load(access, 32, i32(4));
    const oldEax = s.read(s.reg("eax"));
    const oldEdx = s.read(s.reg("edx"));
    const equal = oldEax.eq(oldLo).and(oldEdx.eq(oldHi));

    s.writeFlag("ZF", equal);
    s.if(equal, (then) => {
      then.memory.store(access, then.read(then.reg("ebx")));
      then.memory.store(access, then.read(then.reg("ecx")), i32(4));
    });
    s.write(s.reg("eax"), select(equal, oldEax, oldLo));
    s.write(s.reg("edx"), select(equal, oldEdx, oldHi));
  };
}
