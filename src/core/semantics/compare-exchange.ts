import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { Value, ValueInput } from "#core/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";
import { addFlagSource, subFlagSource } from "./flag-writes.js";
import {
  readStorage,
  resolveMemoryAccess,
  resolveStorageRead,
  resolveStorageReadWrite,
  writeStorage
} from "./memory.js";

export function cmpxchgSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const acc = s.reg(accumulator(width));

    const dstAccess = resolveStorageReadWrite(s, v, context, dst, width);
    const srcAccess = resolveStorageRead(s, v, context, src, width);

    const oldDst = v.truncate(width, readStorage(s, v, dstAccess, width));
    const oldSrc = v.truncate(width, readStorage(s, v, srcAccess, width));
    const oldAcc = v.truncate(width, s.get(acc, width));
    const result = v.truncate(width, v.binary("sub", oldAcc, oldDst));
    const equal = v.compare(width, "eq", oldAcc, oldDst);

    s.writeStatusFlagsSource(subFlagSource({ width, left: oldAcc, right: oldDst, result }));
    s.ifElse(
      equal,
      (then, thenValues) => writeStorage(then, thenValues, dstAccess, oldSrc, width),
      (otherwise) => otherwise.set(acc, oldDst, width)
    );
  };
}

export function xaddSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const dstAccess = resolveStorageReadWrite(s, v, context, dst, width);
    const srcAccess = resolveStorageReadWrite(s, v, context, src, width);

    const oldDst = v.truncate(width, readStorage(s, v, dstAccess, width));
    const oldSrc = v.truncate(width, readStorage(s, v, srcAccess, width));
    const result = v.truncate(width, v.binary("add", oldDst, oldSrc));

    s.writeStatusFlagsSource(addFlagSource({ width, left: oldDst, right: oldSrc, result }));
    writeStorage(s, v, srcAccess, oldDst, width);
    writeStorage(s, v, dstAccess, result, width);
  };
}

export function cmpxchg8bSemantic(): SemanticTemplate {
  return (s, v) => {
    const access = resolveMemoryAccess(s, s.operandMem(s.operand(0)), v.const(8), "write");
    const oldLo = s.memoryRead(access, v.const(0), 32);
    const oldHi = s.memoryRead(access, v.const(4), 32);
    const oldEax = s.get(s.reg("eax"), 32);
    const oldEdx = s.get(s.reg("edx"), 32);
    const equal = and(
      v,
      v.compare(32, "eq", oldEax, oldLo),
      v.compare(32, "eq", oldEdx, oldHi)
    );

    s.writeFlag("ZF", equal);
    s.if(equal, (then, thenValues) => {
      then.memoryWrite(access, thenValues.const(0), then.get(then.reg("ebx"), 32), 32);
      then.memoryWrite(access, thenValues.const(4), then.get(then.reg("ecx"), 32), 32);
    });
    s.set(s.reg("eax"), v.select(equal, oldEax, oldLo), 32);
    s.set(s.reg("edx"), v.select(equal, oldEdx, oldHi), 32);
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
