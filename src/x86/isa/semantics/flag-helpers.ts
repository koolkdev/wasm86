import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import type {
  IrBuilder,
  IrFlagWrite,
  ValueInput,
  ValueRef
} from "#x86/ir/model/types.js";

export type LogicFlagOp = "and" | "or" | "xor";

export type ResultAndFlags = Readonly<{
  result: ValueRef;
  flags: IrFlagWrite;
}>;

export type AddResultAndFlagsInput = Readonly<{
  width: OperandWidth;
  left: ValueInput;
  right: ValueInput;
  carryIn?: ValueInput;
}>;

export type SubResultAndFlagsInput = Readonly<{
  width: OperandWidth;
  left: ValueInput;
  right: ValueInput;
  borrowIn?: ValueInput;
}>;

export type LogicResultAndFlagsInput = Readonly<{
  width: OperandWidth;
  op: LogicFlagOp;
  left: ValueInput;
  right: ValueInput;
}>;

export type BinaryFlagInput = Readonly<{
  width: OperandWidth;
  left: ValueInput;
  right: ValueInput;
}>;

export type UnaryResultFlagInput = Readonly<{
  width: OperandWidth;
  input: ValueInput;
  result: ValueInput;
}>;

type ResultFlagDag = Readonly<{
  width: OperandWidth;
  result: ValueRef;
}>;

type BinaryFlagDag = ResultFlagDag & Readonly<{
  a: ValueRef;
  b: ValueRef;
  aXorResult: ValueRef;
  bXorResult: ValueRef;
  aXorB: ValueRef;
  aXorBXorResult: ValueRef;
}>;

export function buildAddResultAndFlags(s: IrBuilder, input: AddResultAndFlagsInput): ResultAndFlags {
  const width = input.width;
  const a = projectInput(s, width, input.left);
  const b = projectInput(s, width, input.right);
  const rawResult = input.carryIn === undefined
    ? s.i32Add(a, b)
    : s.i32Add(s.i32Add(a, b), input.carryIn);
  const dag = buildBinaryFlagDag(s, width, a, b, rawResult);

  return {
    result: dag.result,
    flags: {
      cells: {
        ...zspCells(s, dag),
        ...addCarryCells(s, dag, input.carryIn)
      }
    }
  };
}

export function buildSubResultAndFlags(s: IrBuilder, input: SubResultAndFlagsInput): ResultAndFlags {
  const width = input.width;
  const a = projectInput(s, width, input.left);
  const b = projectInput(s, width, input.right);
  const rawResult = input.borrowIn === undefined
    ? s.i32Sub(a, b)
    : s.i32Sub(s.i32Sub(a, b), input.borrowIn);
  const dag = buildBinaryFlagDag(s, width, a, b, rawResult);

  return {
    result: dag.result,
    flags: {
      cells: {
        ...zspCells(s, dag),
        ...subCarryCells(s, dag, input.borrowIn)
      }
    }
  };
}

export function buildLogicResultAndFlags(s: IrBuilder, input: LogicResultAndFlagsInput): ResultAndFlags {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const rawResult = logicResult(s, input.op, left, right);
  const result = projectResult(s, width, rawResult);

  return {
    result,
    flags: logicFlags(s, width, result)
  };
}

export function buildCmpFlags(s: IrBuilder, input: BinaryFlagInput): IrFlagWrite {
  const width = input.width;
  const a = projectInput(s, width, input.left);
  const b = projectInput(s, width, input.right);
  const dag = buildBinaryFlagDag(s, width, a, b, s.i32Sub(a, b));

  return {
    cells: {
      ...zspCells(s, dag),
      ...subCarryCells(s, dag)
    },
    conditions: {
      E: s.compare(width, "eq", dag.a, dag.b),
      NE: s.compare(width, "ne", dag.a, dag.b),
      B: s.compare(width, "lt_u", dag.a, dag.b),
      AE: s.compare(width, "ge_u", dag.a, dag.b),
      BE: s.compare(width, "le_u", dag.a, dag.b),
      A: s.compare(width, "gt_u", dag.a, dag.b),
      L: s.compare(width, "lt_s", dag.a, dag.b),
      GE: s.compare(width, "ge_s", dag.a, dag.b),
      LE: s.compare(width, "le_s", dag.a, dag.b),
      G: s.compare(width, "gt_s", dag.a, dag.b)
    }
  };
}

export function buildTestFlags(s: IrBuilder, input: BinaryFlagInput): IrFlagWrite {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const result = projectResult(s, width, s.i32And(left, right));

  return {
    ...logicFlags(s, width, result),
    conditions: {
      E: s.compare(width, "eq", result, 0),
      NE: s.compare(width, "ne", result, 0)
    }
  };
}

export function buildIncFlags(s: IrBuilder, input: UnaryResultFlagInput): IrFlagWrite {
  const width = input.width;
  const left = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);

  return {
    cells: {
      ...zspCells(s, { width, result }),
      AF: s.flagExpr(s.compare(32, "eq", lowNibble(s, left), 0xf)),
      OF: s.flagExpr(s.compare(width, "eq", left, maxSignedValue(width)))
    }
  };
}

export function buildDecFlags(s: IrBuilder, input: UnaryResultFlagInput): IrFlagWrite {
  const width = input.width;
  const left = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);

  return {
    cells: {
      ...zspCells(s, { width, result }),
      AF: s.flagExpr(s.compare(32, "eq", lowNibble(s, left), 0)),
      OF: s.flagExpr(s.compare(width, "eq", left, minSignedValue(width)))
    }
  };
}

export function buildNegFlags(s: IrBuilder, input: UnaryResultFlagInput): IrFlagWrite {
  const width = input.width;
  const value = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);

  return {
    cells: {
      ...zspCells(s, { width, result }),
      CF: s.flagExpr(s.compare(width, "ne", value, 0)),
      AF: s.flagExpr(s.compare(32, "ne", lowNibble(s, value), 0)),
      OF: s.flagExpr(s.compare(width, "eq", value, minSignedValue(width)))
    }
  };
}

function logicFlags(s: IrBuilder, width: OperandWidth, result: ValueRef): IrFlagWrite {
  return {
    cells: {
      ...zspCells(s, { width, result }),
      CF: s.flagExpr(0),
      AF: s.flagUndef(),
      OF: s.flagExpr(0)
    }
  };
}

function zspCells(s: IrBuilder, dag: ResultFlagDag): IrFlagWrite["cells"] {
  return {
    ZF: s.flagExpr(s.compare(dag.width, "eq", dag.result, 0)),
    SF: s.flagExpr(signBit(s, dag.width, dag.result)),
    PF: s.flagExpr(parityFlag(s, dag.result))
  };
}

function addCarryCells(
  s: IrBuilder,
  dag: BinaryFlagDag,
  carryIn?: ValueInput
): Required<Pick<IrFlagWrite["cells"], "CF" | "AF" | "OF">> {
  return {
    CF: s.flagExpr(addCarry(s, dag, carryIn)),
    AF: s.flagExpr(auxCarry(s, dag)),
    OF: s.flagExpr(signBit(s, dag.width, s.i32And(dag.aXorResult, dag.bXorResult)))
  };
}

function subCarryCells(
  s: IrBuilder,
  dag: BinaryFlagDag,
  borrowIn?: ValueInput
): Required<Pick<IrFlagWrite["cells"], "CF" | "AF" | "OF">> {
  return {
    CF: s.flagExpr(subBorrow(s, dag, borrowIn)),
    AF: s.flagExpr(auxCarry(s, dag)),
    OF: s.flagExpr(signBit(s, dag.width, s.i32And(dag.aXorB, dag.aXorResult)))
  };
}

function addCarry(
  s: IrBuilder,
  dag: BinaryFlagDag,
  carryIn?: ValueInput
): ValueRef {
  const carry = s.compare(dag.width, "lt_u", dag.result, dag.a);

  if (carryIn === undefined) {
    return carry;
  }

  return s.i32Select(carryIn, s.compare(dag.width, "le_u", dag.result, dag.a), carry);
}

function subBorrow(
  s: IrBuilder,
  dag: BinaryFlagDag,
  borrowIn?: ValueInput
): ValueRef {
  const borrow = s.compare(dag.width, "lt_u", dag.a, dag.b);

  if (borrowIn === undefined) {
    return borrow;
  }

  return s.i32Select(borrowIn, s.compare(dag.width, "le_u", dag.a, dag.b), borrow);
}

function auxCarry(s: IrBuilder, dag: BinaryFlagDag): ValueRef {
  return lowBit(s, s.i32ShrU(dag.aXorBXorResult, 4));
}

function parityFlag(s: IrBuilder, value: ValueInput): ValueRef {
  const lowByte = s.i32And(value, 0xff);
  const odd = lowBit(s, s.i32Popcnt(lowByte));

  return s.compare(32, "eq", odd, 0);
}

function projectInput(s: IrBuilder, width: OperandWidth, value: ValueInput): ValueRef {
  return projectValue(s, width, value);
}

function projectResult(s: IrBuilder, width: OperandWidth, value: ValueInput): ValueRef {
  return projectValue(s, width, value);
}

function projectValue(s: IrBuilder, width: OperandWidth, value: ValueInput): ValueRef {
  return s.project(width, valueRef(s, value));
}

function buildBinaryFlagDag(
  s: IrBuilder,
  width: OperandWidth,
  a: ValueRef,
  b: ValueRef,
  rawResult: ValueInput
): BinaryFlagDag {
  const result = projectResult(s, width, rawResult);
  const aXorResult = s.i32Xor(a, result);
  const bXorResult = s.i32Xor(b, result);
  const aXorB = s.i32Xor(a, b);
  const aXorBXorResult = s.i32Xor(aXorB, result);

  return {
    width,
    a,
    b,
    result,
    aXorResult,
    bXorResult,
    aXorB,
    aXorBXorResult
  };
}

function valueRef(s: IrBuilder, value: ValueInput): ValueRef {
  return typeof value === "number" ? s.const32(value) : value;
}

function logicResult(s: IrBuilder, op: LogicFlagOp, left: ValueRef, right: ValueRef): ValueRef {
  switch (op) {
    case "and":
      return s.i32And(left, right);
    case "or":
      return s.i32Or(left, right);
    case "xor":
      return s.i32Xor(left, right);
  }
}

function signBit(s: IrBuilder, width: OperandWidth, value: ValueInput): ValueRef {
  return s.i32ShrU(value, width - 1);
}

function lowBit(s: IrBuilder, value: ValueInput): ValueRef {
  return s.i32And(value, 1);
}

function lowNibble(s: IrBuilder, value: ValueInput): ValueRef {
  return s.i32And(value, 0xf);
}

function minSignedValue(width: OperandWidth): number {
  return (widthMask(width) ^ (widthMask(width) >>> 1)) >>> 0;
}

function maxSignedValue(width: OperandWidth): number {
  return (minSignedValue(width) - 1) >>> 0;
}
