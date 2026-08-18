import { integer, i32, select, type BitValue, type Integer } from "#compiler/function/values.js";
import type { X86StatusFlag } from "./definitions.js";
import { widthMask, type OperandWidth } from "../types.js";

export type StatusFlagValues = Readonly<Record<X86StatusFlag, BitValue>>;

export type ShiftFlagOp = "shl" | "shr" | "sar" | "shld" | "shrd";
export type RotateFlagOp = "rol" | "ror" | "rcl" | "rcr";

export type BinaryFlagInput<Width extends OperandWidth> = Readonly<{
  left: Integer<Width>;
  right: Integer<NoInfer<Width>>;
  result: Integer<NoInfer<Width>>;
}>;

export type AddFlagInput<Width extends OperandWidth> = BinaryFlagInput<Width> &
  Readonly<{
    carryIn?: BitValue;
  }>;

export type SubFlagInput<Width extends OperandWidth> = BinaryFlagInput<Width> &
  Readonly<{
    borrowIn?: BitValue;
  }>;

export type ResultFlagInput<Width extends OperandWidth> = Readonly<{
  result: Integer<Width>;
}>;

export type LogicFlagInput<Width extends OperandWidth> = ResultFlagInput<Width> &
  Readonly<{
    undefinedAF: BitValue;
  }>;

export type UnaryFlagInput<Width extends OperandWidth> = Readonly<{
  input: Integer<Width>;
  result: Integer<NoInfer<Width>>;
}>;

export type ShiftFlagInput<Width extends OperandWidth> = Readonly<{
  op: ShiftFlagOp;
  value: Integer<Width>;
  count: Integer<8>;
  result: Integer<NoInfer<Width>>;
}>;

export type RotateFlagInput<Width extends OperandWidth> = Readonly<{
  op: RotateFlagOp;
  count: Integer<8>;
  result: Integer<Width>;
  carry: BitValue;
  carryDefined: BitValue;
}>;

export type ShiftStatusFlagInput<Width extends OperandWidth> = ShiftFlagInput<Width> &
  Readonly<{
    oldFlags: StatusFlagValues;
  }>;

export type RotateStatusFlagInput<Width extends OperandWidth> = RotateFlagInput<Width> &
  Readonly<{
    oldFlags: Pick<StatusFlagValues, "CF" | "OF">;
  }>;

export function addStatusFlagValues<Width extends OperandWidth>(
  input: AddFlagInput<Width>
): StatusFlagValues {
  const dag = binaryFlagDag(input);

  return {
    ...zspValues(dag.result),
    CF: addCarry(dag, input.carryIn),
    AF: auxCarry(dag),
    OF: dag.leftXorResult.and(dag.rightXorResult).msb()
  };
}

export function subStatusFlagValues<Width extends OperandWidth>(
  input: SubFlagInput<Width>
): StatusFlagValues {
  const dag = binaryFlagDag(input);

  return {
    ...zspValues(dag.result),
    CF: subBorrow(dag, input.borrowIn),
    AF: auxCarry(dag),
    OF: dag.leftXorRight.and(dag.leftXorResult).msb()
  };
}

export function logicStatusFlagValues<Width extends OperandWidth>(
  input: LogicFlagInput<Width>
): StatusFlagValues {
  const zero = integer(1, 0);

  return {
    ...zspValues(input.result),
    CF: zero,
    AF: input.undefinedAF,
    OF: zero
  };
}

export function incStatusFlagValues<Width extends OperandWidth>(
  input: UnaryFlagInput<Width>
): Pick<StatusFlagValues, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const left = input.input;
  const result = input.result;

  return {
    ...zspValues(result),
    AF: lowNibble(left).eq(0xf),
    OF: left.eq(maxSignedValue(left.width))
  };
}

export function decStatusFlagValues<Width extends OperandWidth>(
  input: UnaryFlagInput<Width>
): Pick<StatusFlagValues, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const left = input.input;
  const result = input.result;

  return {
    ...zspValues(result),
    AF: lowNibble(left).eq(0),
    OF: left.eq(minSignedValue(left.width))
  };
}

export function negStatusFlagValues<Width extends OperandWidth>(
  input: UnaryFlagInput<Width>
): StatusFlagValues {
  const value = input.input;
  const result = input.result;

  return {
    ...zspValues(result),
    CF: value.ne(0),
    AF: lowNibble(value).ne(0),
    OF: value.eq(minSignedValue(value.width))
  };
}

export function shiftStatusFlagValues<Width extends OperandWidth>(
  input: ShiftStatusFlagInput<Width>
): StatusFlagValues {
  const zero = integer(1, 0);
  const count = input.count;
  const width = input.value.width;
  const countIsOne = count.eq(1);
  const cf = shiftCarry(input);
  const of = shiftOverflow({ ...input, cf });
  const countNonZero = count.ne(0);
  const countLeWidth = count.unsigned.le(width);
  const cfDefined = countNonZero.and(countLeWidth);
  const zsp = zspValues(input.result);
  const nonzeroOf = select(countIsOne, of, zero);

  return {
    CF: select(cfDefined, cf, input.oldFlags.CF),
    PF: select(countNonZero, zsp.PF, input.oldFlags.PF),
    AF: select(countNonZero, zero, input.oldFlags.AF),
    ZF: select(countNonZero, zsp.ZF, input.oldFlags.ZF),
    SF: select(countNonZero, zsp.SF, input.oldFlags.SF),
    OF: select(countNonZero, nonzeroOf, input.oldFlags.OF)
  };
}

export function rotateStatusFlagValues<Width extends OperandWidth>(
  input: RotateStatusFlagInput<Width>
): Pick<StatusFlagValues, "CF" | "OF"> {
  const zero = integer(1, 0);
  const count = input.count;
  const countIsNonZero = count.ne(0);
  const countIsOne = count.eq(1);
  const definedOf = rotateOverflow(input);
  const nonzeroOf = select(countIsOne, definedOf, zero);

  return {
    CF: select(input.carryDefined, input.carry, input.oldFlags.CF),
    OF: select(countIsNonZero, nonzeroOf, input.oldFlags.OF)
  };
}

type BinaryFlagDag<Width extends OperandWidth> = Readonly<{
  result: Integer<Width>;
  left: Integer<Width>;
  right: Integer<Width>;
  leftXorResult: Integer<Width>;
  rightXorResult: Integer<Width>;
  leftXorRight: Integer<Width>;
  leftXorRightXorResult: Integer<Width>;
}>;

function binaryFlagDag<Width extends OperandWidth>(
  input: BinaryFlagInput<Width>
): BinaryFlagDag<Width> {
  const { left, right, result } = input;
  const leftXorResult = left.xor(result);
  const rightXorResult = right.xor(result);
  const leftXorRight = left.xor(right);

  return {
    left,
    right,
    result,
    leftXorResult,
    rightXorResult,
    leftXorRight,
    leftXorRightXorResult: leftXorRight.xor(result)
  };
}

export function zspValues<Width extends OperandWidth>(
  result: Integer<Width>
): Pick<StatusFlagValues, "ZF" | "SF" | "PF"> {
  return {
    ZF: result.eq(0),
    SF: result.msb(),
    PF: parityFlag(result)
  };
}

function addCarry<Width extends OperandWidth>(
  dag: BinaryFlagDag<Width>,
  carryIn?: BitValue
): BitValue {
  const result = dag.result.unsigned;
  const carry = result.lt(dag.left);

  return carryIn === undefined ? carry : select(carryIn, result.le(dag.left), carry);
}

function subBorrow<Width extends OperandWidth>(
  dag: BinaryFlagDag<Width>,
  borrowIn?: BitValue
): BitValue {
  const left = dag.left.unsigned;
  const borrow = left.lt(dag.right);

  return borrowIn === undefined ? borrow : select(borrowIn, left.le(dag.right), borrow);
}

function auxCarry<Width extends OperandWidth>(dag: BinaryFlagDag<Width>): BitValue {
  return dag.leftXorRightXorResult.bit(4);
}

function shiftCarry<Width extends OperandWidth>(
  input: Pick<ShiftFlagInput<Width>, "op" | "value" | "count">
): BitValue {
  const count = input.count.unsigned.extend(32);
  const shift =
    input.op === "shl" || input.op === "shld" ? i32(input.value.width).sub(count) : count.sub(1);

  return input.value.bit(shift);
}

function shiftOverflow<Width extends OperandWidth>(
  input: Pick<ShiftFlagInput<Width>, "op" | "value" | "result"> &
    Readonly<{
      cf: BitValue;
    }>
): BitValue {
  switch (input.op) {
    case "shl":
    case "shld":
      return input.result.msb().xor(input.cf);
    case "shr":
      return input.value.msb();
    case "shrd":
      return input.value.msb().xor(input.result.msb());
    case "sar":
      return integer(1, 0);
  }
}

function rotateOverflow<Width extends OperandWidth>(
  input: Pick<RotateFlagInput<Width>, "op" | "result" | "carry">
): BitValue {
  switch (input.op) {
    case "rol":
    case "rcl":
      return input.result.msb().xor(input.carry);
    case "ror":
    case "rcr":
      return input.result.msb().xor(input.result.bit(input.result.width - 2));
  }
}

function parityFlag<Width extends OperandWidth>(value: Integer<Width>): BitValue {
  const odd = value.and(0xff).popcnt().bit(0);

  return odd.eqz();
}

function lowNibble<Width extends OperandWidth>(value: Integer<Width>): Integer<Width> {
  return value.and(0xf);
}

function minSignedValue(width: OperandWidth): number {
  return (widthMask(width) ^ (widthMask(width) >>> 1)) >>> 0;
}

function maxSignedValue(width: OperandWidth): number {
  return (minSignedValue(width) - 1) >>> 0;
}
