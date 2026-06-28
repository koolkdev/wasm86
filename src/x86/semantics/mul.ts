import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { StorageInput, Value } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import { guardStorageRead } from "./memory.js";

type MultiplyKind = "signed" | "unsigned";
type MultiplyProduct = Readonly<{ full: Value; low: Value; high: Value; overflow: Value }>;

export function mulImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitMultiplySemantic("unsigned", width);
}

export function imulImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitMultiplySemantic("signed", width);
}

function implicitMultiplySemantic(kind: MultiplyKind, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, width);

    const right = s.get(src, width);
    const left = s.get(s.reg(accumulatorForWidth(width)), width);
    const product = multiplyProduct(s, kind, width, left, right);

    writeImplicitProduct(s, width, product);
    writeMultiplyFlags(s, product.overflow);
  };
}

export function imulRegRmSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);

    const srcValue = s.get(src, width);
    const dstValue = s.get(dst, width);

    writeImulResult(s, width, dst, dstValue, srcValue);
  };
}

export function imulRegRmImmSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);

    const srcValue = s.get(src, width);
    const immValue = s.get(s.operand(2), width);

    writeImulResult(s, width, dst, srcValue, immValue);
  };
}

function writeImulResult(
  s: SemanticsBuilder,
  width: OperandWidth,
  dst: StorageInput,
  left: Value,
  right: Value
): void {
  const product = multiplyProduct(s, "signed", width, left, right);

  writeMultiplyFlags(s, product.overflow);
  s.set(dst, product.low, width);
}

function writeImplicitProduct(s: SemanticsBuilder, width: OperandWidth, product: MultiplyProduct): void {
  switch (width) {
    case 8:
      s.set(s.reg("ax"), s.project(16, product.full), 16);
      return;
    case 16:
      s.set(s.reg("ax"), product.low, 16);
      s.set(s.reg("dx"), product.high, 16);
      return;
    case 32:
      s.set(s.reg("eax"), product.low, 32);
      s.set(s.reg("edx"), product.high, 32);
      return;
  }
}

function multiplyProduct(
  s: SemanticsBuilder,
  kind: MultiplyKind,
  width: OperandWidth,
  left: Value,
  right: Value
): MultiplyProduct {
  switch (width) {
    case 8:
    case 16:
      return narrowProduct(s, kind, width, left, right);
    case 32:
      return dwordProduct(s, kind, left, right);
  }
}

function narrowProduct(
  s: SemanticsBuilder,
  kind: MultiplyKind,
  width: Extract<OperandWidth, 8 | 16>,
  left: Value,
  right: Value
): MultiplyProduct {
  const signed = kind === "signed";
  const leftFull = s.extend(width, left, signed);
  const rightFull = s.extend(width, right, signed);
  const full = s.binary("mul", leftFull, rightFull);
  const low = s.project(width, full);
  const high = s.project(width, s.binary("shr_u", full, s.const32(width)));
  const overflow = signed
    ? s.compare(32, "ne", full, s.extend(width, low, true))
    : s.compare(width, "ne", high, s.const32(0));

  return { full, low, high, overflow };
}

function dwordProduct(
  s: SemanticsBuilder,
  kind: MultiplyKind,
  left: Value,
  right: Value
): MultiplyProduct {
  const signed = kind === "signed";
  const leftFull = s.extend64(32, left, signed);
  const rightFull = s.extend64(32, right, signed);
  const full = s.binary64("mul", leftFull, rightFull);
  const low = s.project64(32, full);
  const high = s.project64(32, s.binary64("shr_u", full, s.extend64(32, s.const32(32), false)));
  const overflow = signed
    ? s.compare64("ne", full, s.extend64(32, low, true))
    : s.compare(32, "ne", high, s.const32(0));

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

function writeMultiplyFlags(s: SemanticsBuilder, overflow: Value): void {
  const zero = s.const32(0);

  // Undefined MUL/IMUL status flags are fixed to observed deterministic values.
  s.writeFlag("CF", overflow);
  s.writeFlag("PF", s.const32(1));
  s.writeFlag("AF", zero);
  s.writeFlag("ZF", zero);
  s.writeFlag("SF", zero);
  s.writeFlag("OF", overflow);
}
