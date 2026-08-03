import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { InstructionSemantics, SemanticsBuilder } from "#instructions/semantics/builder.js";
import type { StorageInput, Value } from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";

type MultiplyKind = "signed" | "unsigned";
type MultiplyProduct = Readonly<{ full: Value; low: Value; high: Value; overflow: Value }>;

export function mulImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitMultiplySemantic("unsigned", width);
}

export function imulImplicitSemantic(width: OperandWidth): InstructionSemantics {
  return implicitMultiplySemantic("signed", width);
}

function implicitMultiplySemantic(kind: MultiplyKind, width: OperandWidth): InstructionSemantics {
  return (s, v) => {
    const src = s.operand(0);
    const right = s.read(src, { width });
    const left = s.read(s.reg(accumulatorForWidth(width)), { width });
    const product = multiplyProduct(v, kind, width, left, right);

    writeImplicitProduct(s, v, width, product);
    writeMultiplyFlags(s, v, product.overflow);
  };
}

export function imulRegRmSemantic(width: OperandWidth): InstructionSemantics {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const srcValue = s.read(src, { width });
    const dstValue = s.read(dst, { width });

    writeImulResult(s, v, width, dst, dstValue, srcValue);
  };
}

export function imulRegRmImmSemantic(width: OperandWidth): InstructionSemantics {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const srcValue = s.read(src, { width });
    const immValue = s.read(s.operand(2), { width });

    writeImulResult(s, v, width, dst, srcValue, immValue);
  };
}

function writeImulResult(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: OperandWidth,
  dst: StorageInput,
  left: Value,
  right: Value
): void {
  const product = multiplyProduct(v, "signed", width, left, right);

  writeMultiplyFlags(s, v, product.overflow);
  s.write(dst, product.low, { width });
}

function writeImplicitProduct(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: OperandWidth,
  product: MultiplyProduct
): void {
  switch (width) {
    case 8:
      s.write(s.reg("ax"), v.truncate(16, product.full), { width: 16 });
      return;
    case 16:
      s.write(s.reg("ax"), product.low, { width: 16 });
      s.write(s.reg("dx"), product.high, { width: 16 });
      return;
    case 32:
      s.write(s.reg("eax"), product.low, { width: 32 });
      s.write(s.reg("edx"), product.high, { width: 32 });
      return;
  }
}

function multiplyProduct(
  v: ValueBuilder,
  kind: MultiplyKind,
  width: OperandWidth,
  left: Value,
  right: Value
): MultiplyProduct {
  switch (width) {
    case 8:
    case 16:
      return narrowProduct(v, kind, width, left, right);
    case 32:
      return dwordProduct(v, kind, left, right);
  }
}

function narrowProduct(
  v: ValueBuilder,
  kind: MultiplyKind,
  width: Extract<OperandWidth, 8 | 16>,
  left: Value,
  right: Value
): MultiplyProduct {
  const signed = kind === "signed";
  const leftFull = v.extend(width, left, signed);
  const rightFull = v.extend(width, right, signed);
  const full = v.binary("mul", leftFull, rightFull);
  const low = v.truncate(width, full);
  const high = v.truncate(width, v.binary("shr_u", full, v.const(width)));
  const overflow = signed
    ? v.compare(32, "ne", full, v.extend(width, low, true))
    : v.compare(width, "ne", high, v.const(0));

  return { full, low, high, overflow };
}

function dwordProduct(
  v: ValueBuilder,
  kind: MultiplyKind,
  left: Value,
  right: Value
): MultiplyProduct {
  const signed = kind === "signed";
  const leftFull = v.extend64(32, left, signed);
  const rightFull = v.extend64(32, right, signed);
  const full = v.binary64("mul", leftFull, rightFull);
  const low = v.truncate64(32, full);
  const high = v.truncate64(32, v.binary64("shr_u", full, v.extend64(32, v.const(32), false)));
  const overflow = signed
    ? v.compare64("ne", full, v.extend64(32, low, true))
    : v.compare(32, "ne", high, v.const(0));

  return { full, low, high, overflow };
}

function accumulatorForWidth(width: OperandWidth): RegName {
  switch (width) {
    case 8:
      return "al";
    case 16:
      return "ax";
    case 32:
      return "eax";
  }
}

function writeMultiplyFlags(s: SemanticsBuilder, v: ValueBuilder, overflow: Value): void {
  const zero = v.const(0);

  // Undefined MUL/IMUL status flags are fixed to observed deterministic values.
  s.writeFlag("CF", overflow);
  s.writeFlag("PF", v.const(1));
  s.writeFlag("AF", zero);
  s.writeFlag("ZF", zero);
  s.writeFlag("SF", zero);
  s.writeFlag("OF", overflow);
}
