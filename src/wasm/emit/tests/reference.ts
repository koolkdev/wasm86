import type { X86StatusFlag } from "#x86/flags.js";
import { widthMask, type OperandWidth } from "#x86/types.js";

// Test-local arithmetic-flag reference for action e2e ALU cases. It avoids
// production flag-value formulas and records AF = 0 for logic ops.

export type AluOp = "add" | "adc" | "or" | "and" | "sub" | "sbb" | "xor" | "cmp" | "test";

export type FlagByte = 0 | 1;

export type AluFlags = Readonly<Record<X86StatusFlag, FlagByte>>;

export type AluReference = Readonly<{
  // The value left in the destination operand. cmp and test discard their
  // result, so the destination keeps its original value.
  result: number;
  flags: AluFlags;
}>;

export function aluReference(
  op: AluOp,
  width: OperandWidth,
  left: number,
  right: number,
  carryOrBorrow = 0
): AluReference {
  const a = mask(width, left);
  const b = mask(width, right);
  const oldCf = carryOrBorrow === 0 ? 0 : 1;

  switch (op) {
    case "add":
      return addReference(width, a, b);
    case "adc":
      return addReference(width, a, b, oldCf);
    case "sub":
    case "cmp":
      return subReference(width, a, b, op === "cmp");
    case "sbb":
      return subReference(width, a, b, false, oldCf);
    case "and":
    case "or":
    case "xor":
    case "test":
      return logicReference(width, op, a, b);
  }
}

function addReference(width: OperandWidth, a: number, b: number, carryIn = 0): AluReference {
  const result = mask(width, a + b + carryIn);

  return {
    result,
    flags: {
      ...zsp(width, result),
      CF: a + b + carryIn > widthMask(width) ? 1 : 0,
      AF: nibbleCarry(a, b, result),
      OF: signBit(width, (a ^ result) & (b ^ result))
    }
  };
}

function subReference(width: OperandWidth, a: number, b: number, discard: boolean, borrowIn = 0): AluReference {
  const result = mask(width, a - b - borrowIn);

  return {
    result: discard ? a : result,
    flags: {
      ...zsp(width, result),
      CF: a < b + borrowIn ? 1 : 0,
      AF: nibbleCarry(a, b, result),
      OF: signBit(width, (a ^ b) & (a ^ result))
    }
  };
}

function logicReference(width: OperandWidth, op: "and" | "or" | "xor" | "test", a: number, b: number): AluReference {
  const result = mask(width, op === "or" ? a | b : op === "xor" ? a ^ b : a & b);

  return {
    // and/or/xor write the result; test discards it.
    result: op === "and" || op === "or" || op === "xor" ? result : a,
    flags: {
      ...zsp(width, result),
      CF: 0,
      AF: 0,
      OF: 0
    }
  };
}

// ZF, SF, and PF are shared by every form: zero result, the result's sign
// bit, and even parity of the result's low byte.
function zsp(width: OperandWidth, result: number): Pick<AluFlags, "ZF" | "SF" | "PF"> {
  return {
    ZF: result === 0 ? 1 : 0,
    SF: signBit(width, result),
    PF: popcount(result & 0xff) % 2 === 0 ? 1 : 0
  };
}

function nibbleCarry(a: number, b: number, result: number): FlagByte {
  return bit((a ^ b ^ result) >>> 4);
}

function signBit(width: OperandWidth, value: number): FlagByte {
  return bit(value >>> (width - 1));
}

function mask(width: OperandWidth, value: number): number {
  return (value & widthMask(width)) >>> 0;
}

function popcount(value: number): number {
  let bits = value;
  let count = 0;

  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }

  return count;
}

function bit(value: number): FlagByte {
  return (value & 1) === 0 ? 0 : 1;
}
