import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { SemanticTemplate } from "#instructions/semantics/builder.js";
import type { Value, ValueInput } from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";
import { addFlagSource, subFlagSource } from "#core/flags/lazy/sources.js";

export function cmpxchgSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const acc = s.reg(accumulator(width));

    const destination = s.update(dst, { width });
    const oldDst = v.truncate(width, destination.read(s));
    const oldSrc = v.truncate(width, s.read(src, { width }));
    const oldAcc = v.truncate(width, s.read(acc, { width }));
    const result = v.truncate(width, v.binary("sub", oldAcc, oldDst));
    const equal = v.compare(width, "eq", oldAcc, oldDst);

    s.writeStatusFlagsSource(subFlagSource({ width, left: oldAcc, right: oldDst, result }));
    s.ifElse(
      equal,
      (then) => destination.write(then, oldSrc),
      (otherwise) => otherwise.write(acc, oldDst, { width })
    );
  };
}

export function xaddSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const destination = s.update(dst, { width });
    const source = s.update(src, { width });
    const oldDst = v.truncate(width, destination.read(s));
    const oldSrc = v.truncate(width, source.read(s));
    const result = v.truncate(width, v.binary("add", oldDst, oldSrc));

    s.writeStatusFlagsSource(addFlagSource({ width, left: oldDst, right: oldSrc, result }));
    source.write(s, oldDst);
    destination.write(s, result);
  };
}

export function cmpxchg8bSemantic(): SemanticTemplate {
  return (s, v) => {
    const access = s.memory.guard({
      reference: s.memory.operand(s.operand(0)),
      byteLength: v.const(8),
      intent: "write"
    });

    const oldLo = s.memory.load(access, { width: 32 });
    const oldHi = s.memory.load(access, { width: 32, byteOffset: v.const(4) });
    const oldEax = s.read(s.reg("eax"), { width: 32 });
    const oldEdx = s.read(s.reg("edx"), { width: 32 });
    const equal = and(
      v,
      v.compare(32, "eq", oldEax, oldLo),
      v.compare(32, "eq", oldEdx, oldHi)
    );

    s.writeFlag("ZF", equal);
    s.if(equal, (then, thenValues) => {
      then.memory.store(access, {
        width: 32,
        value: then.read(then.reg("ebx"), { width: 32 })
      });
      then.memory.store(access, {
        width: 32,
        byteOffset: thenValues.const(4),
        value: then.read(then.reg("ecx"), { width: 32 })
      });
    });
    s.write(s.reg("eax"), v.select(equal, oldEax, oldLo), { width: 32 });
    s.write(s.reg("edx"), v.select(equal, oldEdx, oldHi), { width: 32 });
  };
}

function accumulator(width: OperandWidth): RegName {
  switch (width) {
    case 8:
      return "al";
    case 16:
      return "ax";
    case 32:
      return "eax";
  }
}

function and(v: ValueBuilder, left: ValueInput, right: ValueInput): Value {
  return v.binary("and", left, right);
}
