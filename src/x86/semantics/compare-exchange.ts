import type { Values } from "#ir/values.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import { addFlagSource, subFlagSource } from "./flag-writes.js";
import { guardStorageRead, guardStorageReadWrite } from "./memory.js";

export function cmpxchgSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const acc = s.reg(accumulator(width));

    guardStorageReadWrite(s, v, context, dst, width);
    guardStorageRead(s, v, context, src, width);

    const oldDst = v.truncate(width, s.get(dst, width));
    const oldSrc = v.truncate(width, s.get(src, width));
    const oldAcc = v.truncate(width, s.get(acc, width));
    const result = v.truncate(width, v.binary("sub", oldAcc, oldDst));
    const equal = v.compare(width, "eq", oldAcc, oldDst);

    s.writeStatusFlagsSource(subFlagSource({ width, left: oldAcc, right: oldDst, result }));
    s.set(acc, v.select(equal, oldAcc, oldDst), width);
    s.set(dst, v.select(equal, oldSrc, oldDst), width);
  };
}

export function xaddSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, v, context, dst, width);
    guardStorageReadWrite(s, v, context, src, width);

    const oldDst = v.truncate(width, s.get(dst, width));
    const oldSrc = v.truncate(width, s.get(src, width));
    const result = v.truncate(width, v.binary("add", oldDst, oldSrc));

    s.writeStatusFlagsSource(addFlagSource({ width, left: oldDst, right: oldSrc, result }));
    s.set(src, oldDst, width);
    s.set(dst, result, width);
  };
}

export function cmpxchg8bSemantic(): SemanticTemplate {
  return (s, v) => {
    const address = s.linearAddress(s.operand(0));
    const highAddress = v.binary("add", address, v.const(4));

    s.memoryGuard(address, v.const(8), "read");
    s.memoryGuard(address, v.const(8), "write");

    const oldLo = s.get(s.mem(address), 32);
    const oldHi = s.get(s.mem(highAddress), 32);
    const oldEax = s.get(s.reg("eax"), 32);
    const oldEdx = s.get(s.reg("edx"), 32);
    const equal = and(
      v,
      v.compare(32, "eq", oldEax, oldLo),
      v.compare(32, "eq", oldEdx, oldHi)
    );

    s.writeFlag("ZF", equal);
    s.set(s.mem(address), v.select(equal, s.get(s.reg("ebx"), 32), oldLo), 32);
    s.set(s.mem(highAddress), v.select(equal, s.get(s.reg("ecx"), 32), oldHi), 32);
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

function and(v: Values, left: ValueInput, right: ValueInput): Value {
  return v.binary("and", left, right);
}
