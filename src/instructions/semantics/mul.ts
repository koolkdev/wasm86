import { integer, type Integer, type BitValue } from "#compiler/function/values.js";
import type { InstructionSemantics, SemanticsBuilder } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { accumulator } from "./registers.js";

type MultiplyKind = "signed" | "unsigned";

type MultiplyProduct<Width extends OperandWidth, FullWidth extends 32 | 64> = Readonly<{
  full: Integer<FullWidth>;
  low: Integer<Width>;
  high: Integer<Width>;
  overflow: BitValue;
}>;

type MultiplyOperation<Width extends OperandWidth, FullWidth extends 32 | 64> = (
  kind: MultiplyKind,
  left: Integer<Width>,
  right: Integer<NoInfer<Width>>
) => MultiplyProduct<Width, FullWidth>;

type ImplicitProductWriter<Width extends OperandWidth, FullWidth extends 32 | 64> = (
  s: SemanticsBuilder,
  product: MultiplyProduct<Width, FullWidth>
) => void;

export function mulImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitMultiplySemantic("unsigned", width);
}

export function imulImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitMultiplySemantic("signed", width);
}

function implicitMultiplySemantic(kind: MultiplyKind, width: OperandWidth): InstructionSemantics {
  switch (width) {
    case 8:
      return implicitMultiplyTemplate(kind, width, narrowProduct, writeByteProduct);
    case 16:
      return implicitMultiplyTemplate(kind, width, narrowProduct, writeWordProduct);
    case 32:
      return implicitMultiplyTemplate(kind, width, dwordProduct, writeDwordProduct);
  }
}

function implicitMultiplyTemplate<Width extends OperandWidth, FullWidth extends 32 | 64>(
  kind: MultiplyKind,
  width: Width,
  multiply: MultiplyOperation<Width, FullWidth>,
  writeProduct: ImplicitProductWriter<Width, FullWidth>
): InstructionSemantics {
  return (s) => {
    const product = multiply(kind, s.read(accumulator(width)), s.read(s.operand(0), width));

    writeProduct(s, product);
    writeMultiplyFlags(s, product.overflow);
  };
}

export function imulRegRmSemantic(width: 16 | 32): InstructionSemantics {
  return explicitImulSemantic(width, 0, 1);
}

export function imulRegRmImmSemantic(width: 16 | 32): InstructionSemantics {
  return explicitImulSemantic(width, 1, 2);
}

function explicitImulSemantic(
  width: 16 | 32,
  leftIndex: number,
  rightIndex: number
): InstructionSemantics {
  switch (width) {
    case 16:
      return explicitImulTemplate(width, leftIndex, rightIndex, narrowProduct);
    case 32:
      return explicitImulTemplate(width, leftIndex, rightIndex, dwordProduct);
  }
}

function explicitImulTemplate<Width extends 16 | 32, FullWidth extends 32 | 64>(
  width: Width,
  leftIndex: number,
  rightIndex: number,
  multiply: MultiplyOperation<Width, FullWidth>
): InstructionSemantics {
  return (s) => {
    const product = multiply(
      "signed",
      s.read(s.operand(leftIndex), width),
      s.read(s.operand(rightIndex), width)
    );

    writeMultiplyFlags(s, product.overflow);
    s.write(s.operand(0), product.low);
  };
}

function writeByteProduct(s: SemanticsBuilder, product: MultiplyProduct<8, 32>): void {
  s.write(s.reg("ax"), product.full.truncate(16));
}

function writeWordProduct(s: SemanticsBuilder, product: MultiplyProduct<16, 32>): void {
  s.write(s.reg("ax"), product.low);
  s.write(s.reg("dx"), product.high);
}

function writeDwordProduct(s: SemanticsBuilder, product: MultiplyProduct<32, 64>): void {
  s.write(s.reg("eax"), product.low);
  s.write(s.reg("edx"), product.high);
}

function narrowProduct<Width extends 8 | 16>(
  kind: MultiplyKind,
  left: Integer<Width>,
  right: Integer<NoInfer<Width>>
): MultiplyProduct<Width, 32> {
  const signed = kind === "signed";
  const leftFull = signed ? left.signed.extend(32) : left.unsigned.extend(32);
  const rightFull = signed ? right.signed.extend(32) : right.unsigned.extend(32);
  const full = leftFull.mul(rightFull);
  const low = full.truncate(left.width);
  const high = full.unsigned.shr(left.width).truncate(left.width);

  return {
    full,
    low,
    high,
    overflow: signed ? full.ne(low.signed.extend(32)) : high.ne(0)
  };
}

function dwordProduct(
  kind: MultiplyKind,
  left: Integer<32>,
  right: Integer<32>
): MultiplyProduct<32, 64> {
  const signed = kind === "signed";
  const leftFull = signed ? left.signed.extend(64) : left.unsigned.extend(64);
  const rightFull = signed ? right.signed.extend(64) : right.unsigned.extend(64);
  const full = leftFull.mul(rightFull);
  const low = full.truncate(32);
  const high = full.unsigned.shr(32).truncate(32);

  return {
    full,
    low,
    high,
    overflow: signed ? full.ne(low.signed.extend(64)) : high.ne(0)
  };
}

function writeMultiplyFlags(s: SemanticsBuilder, overflow: BitValue): void {
  // Undefined MUL/IMUL status flags are fixed to observed deterministic values.
  s.writeFlag("CF", overflow);
  s.writeFlag("PF", integer(1, 1));
  s.writeFlag("AF", integer(1, 0));
  s.writeFlag("ZF", integer(1, 0));
  s.writeFlag("SF", integer(1, 0));
  s.writeFlag("OF", overflow);
}
