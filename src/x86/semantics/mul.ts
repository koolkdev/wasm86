import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { StorageInput, Value } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";
import { guardStorageRead } from "./memory.js";

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
  const product = signedProduct(s, width, left, right);

  writeImulFlags(s, product.overflow);
  s.set(dst, product.result, width);
}

function signedProduct(
  s: SemanticsBuilder,
  width: OperandWidth,
  left: Value,
  right: Value
): Readonly<{ result: Value; overflow: Value }> {
  switch (width) {
    case 8:
    case 16:
      return signedProduct32(s, width, left, right);
    case 32:
      return signedProduct64(s, width, left, right);
  }
}

function signedProduct32(
  s: SemanticsBuilder,
  width: Extract<OperandWidth, 8 | 16>,
  left: Value,
  right: Value
): Readonly<{ result: Value; overflow: Value }> {
  const full = s.binary("mul", s.extend(width, left), s.extend(width, right));
  const result = s.project(width, full);
  const truncated = s.extend(width, result);

  return {
    result,
    overflow: s.compare(32, "ne", full, truncated)
  };
}

function signedProduct64(
  s: SemanticsBuilder,
  width: Extract<OperandWidth, 32>,
  left: Value,
  right: Value
): Readonly<{ result: Value; overflow: Value }> {
  const full = s.binary64("mul", s.extend64(width, left), s.extend64(width, right));
  const result = s.project64(width, full);
  const truncated = s.extend64(width, result);

  return {
    result,
    overflow: s.compare64("ne", full, truncated)
  };
}

function writeImulFlags(s: SemanticsBuilder, overflow: Value): void {
  const zero = s.const32(0);

  // Undefined MUL/IMUL status flags are fixed to observed deterministic values.
  s.writeFlag("CF", overflow);
  s.writeFlag("PF", s.const32(1));
  s.writeFlag("AF", zero);
  s.writeFlag("ZF", zero);
  s.writeFlag("SF", zero);
  s.writeFlag("OF", overflow);
}
