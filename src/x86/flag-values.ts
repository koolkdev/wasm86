import type { SimpleFlagSource } from "./flag-sources.js";
import type { X86StatusFlag } from "./flags.js";
import type { CompareOperator } from "./semantics/ops.js";
import { widthMask, type OperandWidth } from "./types.js";

export type FlagValueOps<TValue extends number> = Readonly<{
  const32(value: number): TValue;
  project(width: OperandWidth, value: TValue): TValue;
  and(a: TValue, b: TValue): TValue;
  xor(a: TValue, b: TValue): TValue;
  shrU(a: TValue, b: TValue): TValue;
  popcnt(value: TValue): TValue;
  compare(width: OperandWidth, operator: CompareOperator, a: TValue, b: TValue): TValue;
  select(condition: TValue, whenTrue: TValue, whenFalse: TValue): TValue;
}>;

export type StatusFlagValues<TValue extends number> =
  Readonly<Record<X86StatusFlag, TValue>>;

export function statusFlagValuesForSource<TValue extends number>(
  ops: FlagValueOps<TValue>,
  source: SimpleFlagSource<TValue>,
  input: Readonly<{ undefinedAF: TValue }>
): StatusFlagValues<TValue> {
  switch (source.kind) {
    case "add":
      return addStatusFlagValues(ops, {
        width: source.width,
        left: ops.project(source.width, source.left),
        right: ops.project(source.width, source.right),
        result: ops.project(source.width, source.result)
      });
    case "sub":
      return subStatusFlagValues(ops, {
        width: source.width,
        left: ops.project(source.width, source.left),
        right: ops.project(source.width, source.right),
        result: ops.project(source.width, source.result)
      });
    case "logic":
      return logicStatusFlagValues(ops, {
        width: source.width,
        result: ops.project(source.width, source.result),
        undefinedAF: input.undefinedAF
      });
  }
}

export function addStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{
    width: OperandWidth;
    left: TValue;
    right: TValue;
    result: TValue;
    carryIn?: TValue;
  }>
): StatusFlagValues<TValue> {
  const dag = binaryFlagDag(ops, input.width, input.left, input.right, input.result);

  return {
    ...zspValues(ops, dag),
    CF: addCarry(ops, dag, input.carryIn),
    AF: auxCarry(ops, dag),
    OF: signBit(ops, input.width, ops.and(dag.leftXorResult, dag.rightXorResult))
  };
}

export function subStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{
    width: OperandWidth;
    left: TValue;
    right: TValue;
    result: TValue;
    borrowIn?: TValue;
  }>
): StatusFlagValues<TValue> {
  const dag = binaryFlagDag(ops, input.width, input.left, input.right, input.result);

  return {
    ...zspValues(ops, dag),
    CF: subBorrow(ops, dag, input.borrowIn),
    AF: auxCarry(ops, dag),
    OF: signBit(ops, input.width, ops.and(dag.leftXorRight, dag.leftXorResult))
  };
}

export function logicStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{
    width: OperandWidth;
    result: TValue;
    undefinedAF: TValue;
  }>
): StatusFlagValues<TValue> {
  const zero = ops.const32(0);

  return {
    ...zspValues(ops, { width: input.width, result: input.result }),
    CF: zero,
    AF: input.undefinedAF,
    OF: zero
  };
}

export function incStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{ width: OperandWidth; input: TValue; result: TValue }>
): Pick<StatusFlagValues<TValue>, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const width = input.width;
  const left = ops.project(width, input.input);
  const result = ops.project(width, input.result);

  return {
    ...zspValues(ops, { width, result }),
    AF: ops.compare(32, "eq", lowNibble(ops, left), ops.const32(0xf)),
    OF: ops.compare(width, "eq", left, ops.const32(maxSignedValue(width)))
  };
}

export function decStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{ width: OperandWidth; input: TValue; result: TValue }>
): Pick<StatusFlagValues<TValue>, "PF" | "AF" | "ZF" | "SF" | "OF"> {
  const width = input.width;
  const left = ops.project(width, input.input);
  const result = ops.project(width, input.result);
  const zero = ops.const32(0);

  return {
    ...zspValues(ops, { width, result }),
    AF: ops.compare(32, "eq", lowNibble(ops, left), zero),
    OF: ops.compare(width, "eq", left, ops.const32(minSignedValue(width)))
  };
}

export function negStatusFlagValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  input: Readonly<{ width: OperandWidth; input: TValue; result: TValue }>
): StatusFlagValues<TValue> {
  const width = input.width;
  const value = ops.project(width, input.input);
  const result = ops.project(width, input.result);
  const zero = ops.const32(0);

  return {
    ...zspValues(ops, { width, result }),
    CF: ops.compare(width, "ne", value, zero),
    AF: ops.compare(32, "ne", lowNibble(ops, value), zero),
    OF: ops.compare(width, "eq", value, ops.const32(minSignedValue(width)))
  };
}

type ResultFlagDag<TValue extends number> = Readonly<{
  width: OperandWidth;
  result: TValue;
}>;

type BinaryFlagDag<TValue extends number> = ResultFlagDag<TValue> & Readonly<{
  left: TValue;
  right: TValue;
  leftXorResult: TValue;
  rightXorResult: TValue;
  leftXorRight: TValue;
  leftXorRightXorResult: TValue;
}>;

function binaryFlagDag<TValue extends number>(
  ops: FlagValueOps<TValue>,
  width: OperandWidth,
  left: TValue,
  right: TValue,
  rawResult: TValue
): BinaryFlagDag<TValue> {
  const leftXorResult = ops.xor(left, rawResult);
  const rightXorResult = ops.xor(right, rawResult);
  const leftXorRight = ops.xor(left, right);

  return {
    width,
    left,
    right,
    result: rawResult,
    leftXorResult,
    rightXorResult,
    leftXorRight,
    leftXorRightXorResult: ops.xor(leftXorRight, rawResult)
  };
}

function zspValues<TValue extends number>(
  ops: FlagValueOps<TValue>,
  dag: ResultFlagDag<TValue>
): Pick<StatusFlagValues<TValue>, "ZF" | "SF" | "PF"> {
  return {
    ZF: ops.compare(dag.width, "eq", dag.result, ops.const32(0)),
    SF: signBit(ops, dag.width, dag.result),
    PF: parityFlag(ops, dag.result)
  };
}

function addCarry<TValue extends number>(
  ops: FlagValueOps<TValue>,
  dag: BinaryFlagDag<TValue>,
  carryIn?: TValue
): TValue {
  const carry = ops.compare(dag.width, "lt_u", dag.result, dag.left);

  if (carryIn === undefined) {
    return carry;
  }

  return ops.select(carryIn, ops.compare(dag.width, "le_u", dag.result, dag.left), carry);
}

function subBorrow<TValue extends number>(
  ops: FlagValueOps<TValue>,
  dag: BinaryFlagDag<TValue>,
  borrowIn?: TValue
): TValue {
  const borrow = ops.compare(dag.width, "lt_u", dag.left, dag.right);

  if (borrowIn === undefined) {
    return borrow;
  }

  return ops.select(borrowIn, ops.compare(dag.width, "le_u", dag.left, dag.right), borrow);
}

function auxCarry<TValue extends number>(
  ops: FlagValueOps<TValue>,
  dag: BinaryFlagDag<TValue>
): TValue {
  return lowBit(ops, ops.shrU(dag.leftXorRightXorResult, ops.const32(4)));
}

function parityFlag<TValue extends number>(
  ops: FlagValueOps<TValue>,
  value: TValue
): TValue {
  const lowByte = ops.and(value, ops.const32(0xff));
  const odd = lowBit(ops, ops.popcnt(lowByte));

  return ops.compare(32, "eq", odd, ops.const32(0));
}

function signBit<TValue extends number>(
  ops: FlagValueOps<TValue>,
  width: OperandWidth,
  value: TValue
): TValue {
  return ops.shrU(value, ops.const32(width - 1));
}

function lowBit<TValue extends number>(
  ops: FlagValueOps<TValue>,
  value: TValue
): TValue {
  return ops.and(value, ops.const32(1));
}

function lowNibble<TValue extends number>(
  ops: FlagValueOps<TValue>,
  value: TValue
): TValue {
  return ops.and(value, ops.const32(0xf));
}

function minSignedValue(width: OperandWidth): number {
  return (widthMask(width) ^ (widthMask(width) >>> 1)) >>> 0;
}

function maxSignedValue(width: OperandWidth): number {
  return (minSignedValue(width) - 1) >>> 0;
}
