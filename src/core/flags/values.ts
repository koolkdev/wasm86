import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { X86StatusFlag } from "./definitions.js";
import { widthMask, type OperandWidth } from "../types.js";

export type StatusFlagValues = Readonly<Record<X86StatusFlag, ValueId>>;

export type ShiftFlagOp = "shl" | "shr" | "sar" | "shld" | "shrd";
export type RotateFlagOp = "rol" | "ror" | "rcl" | "rcr";

export function addStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueId;
    right: ValueId;
    result: ValueId;
    carryIn?: ValueId;
  }>
): StatusFlagValues {
  const dag = binaryFlagDag(values, input.width, input.left, input.right, input.result);

  return {
    ...zspValues(values, dag),
    CF: addCarry(values, dag, input.carryIn),
    AF: auxCarry(values, dag),
    OF: signBit(
      values,
      input.width,
      values.binary("and", dag.leftXorResult, dag.rightXorResult)
    )
  };
}

export function subStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{
    width: OperandWidth;
    left: ValueId;
    right: ValueId;
    result: ValueId;
    borrowIn?: ValueId;
  }>
): StatusFlagValues {
  const dag = binaryFlagDag(values, input.width, input.left, input.right, input.result);

  return {
    ...zspValues(values, dag),
    CF: subBorrow(values, dag, input.borrowIn),
    AF: auxCarry(values, dag),
    OF: signBit(
      values,
      input.width,
      values.binary("and", dag.leftXorRight, dag.leftXorResult)
    )
  };
}

export function logicStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{
    width: OperandWidth;
    result: ValueId;
    undefinedAF: ValueId;
  }>
): StatusFlagValues {
  const zero = values.const(0);

  return {
    ...zspValues(values, { width: input.width, result: input.result }),
    CF: zero,
    AF: input.undefinedAF,
    OF: zero
  };
}

export function incStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueId; result: ValueId }>
): Pick<StatusFlagValues, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const width = input.width;
  const left = values.truncate(width, input.input);
  const result = values.truncate(width, input.result);

  return {
    ...zspValues(values, { width, result }),
    AF: values.compare(32, "eq", lowNibble(values, left), values.const(0xf)),
    OF: values.compare(width, "eq", left, values.const(maxSignedValue(width)))
  };
}

export function decStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueId; result: ValueId }>
): Pick<StatusFlagValues, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const width = input.width;
  const left = values.truncate(width, input.input);
  const result = values.truncate(width, input.result);
  const zero = values.const(0);

  return {
    ...zspValues(values, { width, result }),
    AF: values.compare(32, "eq", lowNibble(values, left), zero),
    OF: values.compare(width, "eq", left, values.const(minSignedValue(width)))
  };
}

export function negStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{ width: OperandWidth; input: ValueId; result: ValueId }>
): StatusFlagValues {
  const width = input.width;
  const value = values.truncate(width, input.input);
  const result = values.truncate(width, input.result);
  const zero = values.const(0);

  return {
    ...zspValues(values, { width, result }),
    CF: values.compare(width, "ne", value, zero),
    AF: values.compare(32, "ne", lowNibble(values, value), zero),
    OF: values.compare(width, "eq", value, values.const(minSignedValue(width)))
  };
}

export function shiftStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueId;
    count: ValueId;
    result: ValueId;
    oldFlags: StatusFlagValues;
  }>
): StatusFlagValues {
  const zero = values.const(0);
  const one = values.const(1);
  const countIsOne = values.compare(32, "eq", input.count, one);
  const cf = shiftCarry(values, input);
  const of = shiftOverflow(values, { ...input, cf });
  const countNonZero = values.compare(32, "ne", input.count, zero);
  const countLeWidth = values.compare(
    32,
    "le_u",
    input.count,
    values.const(input.width)
  );
  const cfDefined = values.binary("and", countNonZero, countLeWidth);
  const zsp = zspValues(values, { width: input.width, result: input.result });
  const nonzeroOf = values.select(countIsOne, of, zero);

  return {
    CF: values.select(cfDefined, cf, input.oldFlags.CF),
    PF: values.select(countNonZero, zsp.PF, input.oldFlags.PF),
    AF: values.select(countNonZero, zero, input.oldFlags.AF),
    ZF: values.select(countNonZero, zsp.ZF, input.oldFlags.ZF),
    SF: values.select(countNonZero, zsp.SF, input.oldFlags.SF),
    OF: values.select(countNonZero, nonzeroOf, input.oldFlags.OF)
  };
}

export function rotateStatusFlagValues(
  values: ValueBuilder,
  input: Readonly<{
    op: RotateFlagOp;
    width: OperandWidth;
    count: ValueId;
    result: ValueId;
    carry: ValueId;
    carryDefined: ValueId;
    oldFlags: Pick<StatusFlagValues, "CF" | "OF">;
  }>
): Pick<StatusFlagValues, "CF" | "OF"> {
  const zero = values.const(0);
  const countIsNonZero = values.compare(32, "ne", input.count, zero);
  const countIsOne = values.compare(32, "eq", input.count, values.const(1));
  const definedOf = rotateOverflow(values, input);
  const nonzeroOf = values.select(countIsOne, definedOf, zero);

  return {
    CF: values.select(input.carryDefined, input.carry, input.oldFlags.CF),
    OF: values.select(countIsNonZero, nonzeroOf, input.oldFlags.OF)
  };
}

type ResultFlagDag = Readonly<{
  width: OperandWidth;
  result: ValueId;
}>;

type BinaryFlagDag = ResultFlagDag & Readonly<{
  left: ValueId;
  right: ValueId;
  leftXorResult: ValueId;
  rightXorResult: ValueId;
  leftXorRight: ValueId;
  leftXorRightXorResult: ValueId;
}>;

function binaryFlagDag(
  values: ValueBuilder,
  width: OperandWidth,
  left: ValueId,
  right: ValueId,
  rawResult: ValueId
): BinaryFlagDag {
  const leftXorResult = values.binary("xor", left, rawResult);
  const rightXorResult = values.binary("xor", right, rawResult);
  const leftXorRight = values.binary("xor", left, right);

  return {
    width,
    left,
    right,
    result: rawResult,
    leftXorResult,
    rightXorResult,
    leftXorRight,
    leftXorRightXorResult: values.binary("xor", leftXorRight, rawResult)
  };
}

export function zspValues(
  values: ValueBuilder,
  dag: ResultFlagDag
): Pick<StatusFlagValues, "ZF" | "SF" | "PF"> {
  return {
    ZF: values.compare(dag.width, "eq", dag.result, values.const(0)),
    SF: signBit(values, dag.width, dag.result),
    PF: parityFlag(values, dag.result)
  };
}

function addCarry(
  values: ValueBuilder,
  dag: BinaryFlagDag,
  carryIn?: ValueId
): ValueId {
  const carry = values.compare(dag.width, "lt_u", dag.result, dag.left);

  if (carryIn === undefined) {
    return carry;
  }

  return values.select(
    carryIn,
    values.compare(dag.width, "le_u", dag.result, dag.left),
    carry
  );
}

function subBorrow(
  values: ValueBuilder,
  dag: BinaryFlagDag,
  borrowIn?: ValueId
): ValueId {
  const borrow = values.compare(dag.width, "lt_u", dag.left, dag.right);

  if (borrowIn === undefined) {
    return borrow;
  }

  return values.select(
    borrowIn,
    values.compare(dag.width, "le_u", dag.left, dag.right),
    borrow
  );
}

function auxCarry(values: ValueBuilder, dag: BinaryFlagDag): ValueId {
  return lowBit(
    values,
    values.binary("shr_u", dag.leftXorRightXorResult, values.const(4))
  );
}

function shiftCarry(
  values: ValueBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueId;
    count: ValueId;
  }>
): ValueId {
  const shift = input.op === "shl" || input.op === "shld"
    ? values.binary("sub", values.const(input.width), input.count)
    : values.binary("sub", input.count, values.const(1));

  return lowBit(values, values.binary("shr_u", input.value, shift));
}

function shiftOverflow(
  values: ValueBuilder,
  input: Readonly<{
    op: ShiftFlagOp;
    width: OperandWidth;
    value: ValueId;
    result: ValueId;
    cf: ValueId;
  }>
): ValueId {
  switch (input.op) {
    case "shl":
    case "shld":
      return values.binary(
        "xor",
        signBit(values, input.width, input.result),
        input.cf
      );
    case "shr":
      return signBit(values, input.width, input.value);
    case "shrd":
      return values.binary(
        "xor",
        signBit(values, input.width, input.value),
        signBit(values, input.width, input.result)
      );
    case "sar":
      return values.const(0);
  }
}

function rotateOverflow(
  values: ValueBuilder,
  input: Readonly<{
    op: RotateFlagOp;
    width: OperandWidth;
    result: ValueId;
    carry: ValueId;
  }>
): ValueId {
  switch (input.op) {
    case "rol":
    case "rcl":
      return values.binary(
        "xor",
        signBit(values, input.width, input.result),
        input.carry
      );
    case "ror":
    case "rcr":
      return values.binary(
        "xor",
        signBit(values, input.width, input.result),
        nextSignBit(values, input.width, input.result)
      );
  }
}

function parityFlag(values: ValueBuilder, value: ValueId): ValueId {
  const lowByte = values.binary("and", value, values.const(0xff));
  const odd = lowBit(values, values.unary("popcnt", lowByte));

  return values.compare(32, "eq", odd, values.const(0));
}

export function bitAt(
  values: ValueBuilder,
  value: ValueId,
  bit: number
): ValueId {
  return lowBit(values, values.binary("shr_u", value, values.const(bit)));
}

export function signBit(
  values: ValueBuilder,
  width: OperandWidth,
  value: ValueId
): ValueId {
  return values.binary("shr_u", value, values.const(width - 1));
}

export function nextSignBit(
  values: ValueBuilder,
  width: OperandWidth,
  value: ValueId
): ValueId {
  return bitAt(values, value, width - 2);
}

export function lowBit(values: ValueBuilder, value: ValueId): ValueId {
  return values.binary("and", value, values.const(1));
}

function lowNibble(values: ValueBuilder, value: ValueId): ValueId {
  return values.binary("and", value, values.const(0xf));
}

function minSignedValue(width: OperandWidth): number {
  return (widthMask(width) ^ (widthMask(width) >>> 1)) >>> 0;
}

function maxSignedValue(width: OperandWidth): number {
  return (minSignedValue(width) - 1) >>> 0;
}
