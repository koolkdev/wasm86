import { widthMask, type OperandWidth } from "#x86/types.js";
import type {
  SemanticsBuilder,
  SimpleFlagSource,
  StatusFlagValues
} from "#x86/semantics/builder.js";
import type { Value, ValueInput } from "#x86/semantics/refs.js";

export type LogicFlagOp = "and" | "or" | "xor";

export type ResultAndFlags = Readonly<{
  result: Value;
  flags: StatusFlagValues;
}>;

export type ResultAndFlagSource = Readonly<{
  result: Value;
  source: SimpleFlagSource;
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

export type LogicResultInput = Readonly<{
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
  result: Value;
}>;

type BinaryFlagDag = ResultFlagDag & Readonly<{
  a: Value;
  b: Value;
  aXorResult: Value;
  bXorResult: Value;
  aXorB: Value;
  aXorBXorResult: Value;
}>;

export function buildAddResultAndFlags(s: SemanticsBuilder, input: AddResultAndFlagsInput): ResultAndFlags {
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
      ...zspValues(s, dag),
      ...addCarryValues(s, dag, input.carryIn)
    }
  };
}

export function buildSubResultAndFlags(s: SemanticsBuilder, input: SubResultAndFlagsInput): ResultAndFlags {
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
      ...zspValues(s, dag),
      ...subCarryValues(s, dag, input.borrowIn)
    }
  };
}

export function buildAddResultAndFlagSource(
  s: SemanticsBuilder,
  input: BinaryFlagInput
): ResultAndFlagSource {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const result = projectResult(s, width, s.i32Add(left, right));

  return {
    result,
    source: { kind: "add", width, left, right, result }
  };
}

export function buildSubResultAndFlagSource(
  s: SemanticsBuilder,
  input: BinaryFlagInput
): ResultAndFlagSource {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const result = projectResult(s, width, s.i32Sub(left, right));

  return {
    result,
    source: { kind: "sub", width, left, right, result }
  };
}

export function buildLogicResultAndFlagSource(
  s: SemanticsBuilder,
  input: LogicResultInput
): ResultAndFlagSource {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const result = projectResult(s, width, logicResult(s, input.op, left, right));

  return {
    result,
    source: { kind: "logic", width, result }
  };
}

export function buildCmpFlagSource(s: SemanticsBuilder, input: BinaryFlagInput): SimpleFlagSource {
  const width = input.width;
  const left = projectInput(s, width, input.left);
  const right = projectInput(s, width, input.right);
  const result = projectResult(s, width, s.i32Sub(left, right));

  return { kind: "sub", width, left, right, result };
}

export function buildTestFlagSource(s: SemanticsBuilder, input: BinaryFlagInput): SimpleFlagSource {
  return buildLogicResultAndFlagSource(s, {
    width: input.width,
    op: "and",
    left: input.left,
    right: input.right
  }).source;
}

// Transitional eager source materialization. Later stages keep sources pending
// and resolve only the requested flag or condition.
export function buildFlagSourceValues(
  s: SemanticsBuilder,
  source: SimpleFlagSource
): StatusFlagValues {
  switch (source.kind) {
    case "add": {
      const a = projectInput(s, source.width, source.left);
      const b = projectInput(s, source.width, source.right);
      const dag = buildBinaryFlagDag(s, source.width, a, b, source.result);

      return {
        ...zspValues(s, dag),
        ...addCarryValues(s, dag)
      };
    }
    case "sub": {
      const a = projectInput(s, source.width, source.left);
      const b = projectInput(s, source.width, source.right);
      const dag = buildBinaryFlagDag(s, source.width, a, b, source.result);

      return {
        ...zspValues(s, dag),
        ...subCarryValues(s, dag)
      };
    }
    case "logic": {
      const result = projectResult(s, source.width, source.result);

      return logicFlags(s, source.width, result);
    }
  }
}

export function writeIncFlags(
  s: SemanticsBuilder,
  input: UnaryResultFlagInput
): void {
  const width = input.width;
  const left = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);

  writeZspFlags(s, { width, result });
  s.writeFlag("AF", s.compare(32, "eq", lowNibble(s, left), s.const32(0xf)));
  s.writeFlag("OF", s.compare(width, "eq", left, s.const32(maxSignedValue(width))));
}

export function writeDecFlags(
  s: SemanticsBuilder,
  input: UnaryResultFlagInput
): void {
  const width = input.width;
  const left = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);
  const zero = s.const32(0);

  writeZspFlags(s, { width, result });
  s.writeFlag("AF", s.compare(32, "eq", lowNibble(s, left), zero));
  s.writeFlag("OF", s.compare(width, "eq", left, s.const32(minSignedValue(width))));
}

export function buildNegFlags(s: SemanticsBuilder, input: UnaryResultFlagInput): StatusFlagValues {
  const width = input.width;
  const value = projectInput(s, width, input.input);
  const result = projectResult(s, width, input.result);
  const zero = s.const32(0);

  return {
    ...zspValues(s, { width, result }),
    CF: s.compare(width, "ne", value, zero),
    AF: s.compare(32, "ne", lowNibble(s, value), zero),
    OF: s.compare(width, "eq", value, s.const32(minSignedValue(width)))
  };
}

function logicFlags(s: SemanticsBuilder, width: OperandWidth, result: Value): StatusFlagValues {
  const zero = s.const32(0);

  return {
    ...zspValues(s, { width, result }),
    CF: zero,
    AF: zero, // Architecturally undefined
    OF: zero
  };
}

function zspValues(
  s: SemanticsBuilder,
  dag: ResultFlagDag
): Pick<StatusFlagValues, "ZF" | "SF" | "PF"> {
  const zero = s.const32(0);

  return {
    ZF: s.compare(dag.width, "eq", dag.result, zero),
    SF: signBit(s, dag.width, dag.result),
    PF: parityFlag(s, dag.result)
  };
}

function addCarryValues(
  s: SemanticsBuilder,
  dag: BinaryFlagDag,
  carryIn?: ValueInput
): Pick<StatusFlagValues, "CF" | "AF" | "OF"> {
  return {
    CF: addCarry(s, dag, carryIn),
    AF: auxCarry(s, dag),
    OF: signBit(s, dag.width, s.i32And(dag.aXorResult, dag.bXorResult))
  };
}

function subCarryValues(
  s: SemanticsBuilder,
  dag: BinaryFlagDag,
  borrowIn?: ValueInput
): Pick<StatusFlagValues, "CF" | "AF" | "OF"> {
  return {
    CF: subBorrow(s, dag, borrowIn),
    AF: auxCarry(s, dag),
    OF: signBit(s, dag.width, s.i32And(dag.aXorB, dag.aXorResult))
  };
}

function writeZspFlags(s: SemanticsBuilder, dag: ResultFlagDag): void {
  const zero = s.const32(0);

  s.writeFlag("ZF", s.compare(dag.width, "eq", dag.result, zero));
  s.writeFlag("SF", signBit(s, dag.width, dag.result));
  s.writeFlag("PF", parityFlag(s, dag.result));
}

function addCarry(
  s: SemanticsBuilder,
  dag: BinaryFlagDag,
  carryIn?: ValueInput
): Value {
  const carry = s.compare(dag.width, "lt_u", dag.result, dag.a);

  if (carryIn === undefined) {
    return carry;
  }

  return s.i32Select(carryIn, s.compare(dag.width, "le_u", dag.result, dag.a), carry);
}

function subBorrow(
  s: SemanticsBuilder,
  dag: BinaryFlagDag,
  borrowIn?: ValueInput
): Value {
  const borrow = s.compare(dag.width, "lt_u", dag.a, dag.b);

  if (borrowIn === undefined) {
    return borrow;
  }

  return s.i32Select(borrowIn, s.compare(dag.width, "le_u", dag.a, dag.b), borrow);
}

function auxCarry(s: SemanticsBuilder, dag: BinaryFlagDag): Value {
  return lowBit(s, s.i32ShrU(dag.aXorBXorResult, s.const32(4)));
}

function parityFlag(s: SemanticsBuilder, value: ValueInput): Value {
  const lowByte = s.i32And(value, s.const32(0xff));
  const odd = lowBit(s, s.i32Popcnt(lowByte));
  const zero = s.const32(0);

  return s.compare(32, "eq", odd, zero);
}

function projectInput(s: SemanticsBuilder, width: OperandWidth, value: ValueInput): Value {
  return projectValue(s, width, value);
}

function projectResult(s: SemanticsBuilder, width: OperandWidth, value: ValueInput): Value {
  return projectValue(s, width, value);
}

function projectValue(s: SemanticsBuilder, width: OperandWidth, value: ValueInput): Value {
  return s.project(width, value);
}

function buildBinaryFlagDag(
  s: SemanticsBuilder,
  width: OperandWidth,
  a: Value,
  b: Value,
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

function logicResult(s: SemanticsBuilder, op: LogicFlagOp, left: Value, right: Value): Value {
  switch (op) {
    case "and":
      return s.i32And(left, right);
    case "or":
      return s.i32Or(left, right);
    case "xor":
      return s.i32Xor(left, right);
  }
}

function signBit(s: SemanticsBuilder, width: OperandWidth, value: ValueInput): Value {
  return s.i32ShrU(value, s.const32(width - 1));
}

function lowBit(s: SemanticsBuilder, value: ValueInput): Value {
  return s.i32And(value, s.const32(1));
}

function lowNibble(s: SemanticsBuilder, value: ValueInput): Value {
  return s.i32And(value, s.const32(0xf));
}

function minSignedValue(width: OperandWidth): number {
  return (widthMask(width) ^ (widthMask(width) >>> 1)) >>> 0;
}

function maxSignedValue(width: OperandWidth): number {
  return (minSignedValue(width) - 1) >>> 0;
}
