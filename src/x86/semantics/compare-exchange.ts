import type { SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import { addFlagSource, subFlagSource } from "./flag-writes.js";
import { guardStorageRead, guardStorageReadWrite } from "./memory.js";

export function cmpxchgSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const acc = s.reg(accumulator(width));

    guardStorageReadWrite(s, context, dst, width);
    guardStorageRead(s, context, src, width);

    const oldDst = s.truncate(width, s.get(dst, width));
    const oldSrc = s.truncate(width, s.get(src, width));
    const oldAcc = s.truncate(width, s.get(acc, width));
    const result = s.truncate(width, s.binary("sub", oldAcc, oldDst));
    const equal = s.compare(width, "eq", oldAcc, oldDst);

    s.writeStatusFlagsSource(subFlagSource({ width, left: oldAcc, right: oldDst, result }));
    s.set(acc, s.select(equal, oldAcc, oldDst), width);
    s.set(dst, s.select(equal, oldSrc, oldDst), width);
  };
}

export function xaddSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, context, dst, width);
    guardStorageReadWrite(s, context, src, width);

    const oldDst = s.truncate(width, s.get(dst, width));
    const oldSrc = s.truncate(width, s.get(src, width));
    const result = s.truncate(width, s.binary("add", oldDst, oldSrc));

    s.writeStatusFlagsSource(addFlagSource({ width, left: oldDst, right: oldSrc, result }));
    s.set(src, oldDst, width);
    s.set(dst, result, width);
  };
}

export function cmpxchg8bSemantic(): SemanticTemplate {
  return (s) => {
    const address = s.linearAddress(s.operand(0));
    const highAddress = s.binary("add", address, s.const32(4));

    s.memoryGuard(address, 8, "read");
    s.memoryGuard(address, 8, "write");

    const oldLo = s.get(s.mem(address), 32);
    const oldHi = s.get(s.mem(highAddress), 32);
    const oldEax = s.get(s.reg("eax"), 32);
    const oldEdx = s.get(s.reg("edx"), 32);
    const equal = and(
      s,
      s.compare(32, "eq", oldEax, oldLo),
      s.compare(32, "eq", oldEdx, oldHi)
    );

    s.writeFlag("ZF", equal);
    s.set(s.mem(address), s.select(equal, s.get(s.reg("ebx"), 32), oldLo), 32);
    s.set(s.mem(highAddress), s.select(equal, s.get(s.reg("ecx"), 32), oldHi), 32);
    s.set(s.reg("eax"), s.select(equal, oldEax, oldLo), 32);
    s.set(s.reg("edx"), s.select(equal, oldEdx, oldHi), 32);
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

function and(s: SemanticsBuilder, left: ValueInput, right: ValueInput): Value {
  return s.binary("and", left, right);
}
