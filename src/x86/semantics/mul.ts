import type { Values } from "#ir/values.js";
import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { StorageInput, Value } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import { readStorage, resolveStorageRead } from "./memory.js";

type MultiplyKind = "signed" | "unsigned";
type MultiplyProduct = Readonly<{ full: Value; low: Value; high: Value; overflow: Value }>;

export function mulImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitMultiplySemantic("unsigned", width);
}

export function imulImplicitSemantic(width: OperandWidth): SemanticTemplate {
  return implicitMultiplySemantic("signed", width);
}

function implicitMultiplySemantic(kind: MultiplyKind, width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const src = s.operand(0);

    const srcStorage = resolveStorageRead(s, v, context, src, width);

    const right = readStorage(s, v, srcStorage, width);
    const left = s.get(s.reg(accumulatorForWidth(width)), width);
    const product = multiplyProduct(v, kind, width, left, right);

    writeImplicitProduct(s, v, width, product);
    writeMultiplyFlags(s, v, product.overflow);
  };
}

export function imulRegRmSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, width);

    const srcValue = readStorage(s, v, srcStorage, width);
    const dstValue = s.get(dst, width);

    writeImulResult(s, v, width, dst, dstValue, srcValue);
  };
}

export function imulRegRmImmSemantic(width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    const srcStorage = resolveStorageRead(s, v, context, src, width);

    const srcValue = readStorage(s, v, srcStorage, width);
    const immValue = s.get(s.operand(2), width);

    writeImulResult(s, v, width, dst, srcValue, immValue);
  };
}

function writeImulResult(
  s: SemanticsBuilder,
  v: Values,
  width: OperandWidth,
  dst: StorageInput,
  left: Value,
  right: Value
): void {
  const product = multiplyProduct(v, "signed", width, left, right);

  writeMultiplyFlags(s, v, product.overflow);
  s.set(dst, product.low, width);
}

function writeImplicitProduct(s: SemanticsBuilder, v: Values, width: OperandWidth, product: MultiplyProduct): void {
  switch (width) {
    case 8:
      s.set(s.reg("ax"), v.truncate(16, product.full), 16);
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
  v: Values,
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
  v: Values,
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
  v: Values,
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

function writeMultiplyFlags(s: SemanticsBuilder, v: Values, overflow: Value): void {
  const zero = v.const(0);

  // Undefined MUL/IMUL status flags are fixed to observed deterministic values.
  s.writeFlag("CF", overflow);
  s.writeFlag("PF", v.const(1));
  s.writeFlag("AF", zero);
  s.writeFlag("ZF", zero);
  s.writeFlag("SF", zero);
  s.writeFlag("OF", overflow);
}
