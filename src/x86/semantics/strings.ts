import { subFlagSource } from "#x86/semantics/flag-writes.js";
import { guardStorageRead, guardStorageWrite } from "#x86/semantics/memory.js";
import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { OperandWidth, RegName } from "#x86/types.js";

export function movsSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);
    const dst = s.operand(1);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);

    stepRegister(s, "esi", delta);
    stepRegister(s, "edi", delta);
  };
}

export function cmpsSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, leftOperand, width);
    guardStorageRead(s, context, rightOperand, width);

    const left = s.truncate(width, s.get(leftOperand, width));
    const right = s.truncate(width, s.get(rightOperand, width));
    const result = s.truncate(width, s.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, "esi", delta);
    stepRegister(s, "edi", delta);
  };
}

export function stosSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const value = s.get(s.reg(accumulator(width)), width);
    const delta = stringDelta(s, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
    stepRegister(s, "edi", delta);
  };
}

export function lodsSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    s.set(s.reg(accumulator(width)), value, width);
    stepRegister(s, "esi", delta);
  };
}

export function scasSemantic(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const rightOperand = s.operand(0);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, rightOperand, width);

    const left = s.truncate(width, s.get(s.reg(accumulator(width)), width));
    const right = s.truncate(width, s.get(rightOperand, width));
    const result = s.truncate(width, s.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, "edi", delta);
  };
}

function stringDelta(s: SemanticsBuilder, width: OperandWidth) {
  const byteLength = width / 8;

  return s.select(s.readFlag("DF"), s.const32(-byteLength), s.const32(byteLength));
}

function stepRegister(s: SemanticsBuilder, reg: "esi" | "edi", delta: ReturnType<typeof stringDelta>): void {
  s.set(s.reg(reg), s.binary("add", s.get(s.reg(reg), 32), delta), 32);
}

function accumulator(width: OperandWidth): RegName {
  switch (width) {
    case 8:
      return "al";
    case 16:
      return "ax";
    case 32:
      return "eax";
  }
}
