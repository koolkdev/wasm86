import { subFlagSource } from "#x86/semantics/flag-writes.js";
import { guardStorageRead, guardStorageWrite } from "#x86/semantics/memory.js";
import type { SemanticTemplate, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";

export function movsSemantic(width: OperandWidth): SemanticTemplate {
  return movsUnit(width);
}

export function repMovsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(movsUnit(width));
}

export function cmpsSemantic(width: OperandWidth): SemanticTemplate {
  return cmpsUnit(width);
}

export function repeCmpsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(cmpsUnit(width), "E");
}

export function repneCmpsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(cmpsUnit(width), "NE");
}

export function stosSemantic(width: OperandWidth): SemanticTemplate {
  return stosUnit(width);
}

export function repStosSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(stosUnit(width));
}

export function lodsSemantic(width: OperandWidth): SemanticTemplate {
  return lodsUnit(width);
}

export function repLodsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(lodsUnit(width));
}

export function scasSemantic(width: OperandWidth): SemanticTemplate {
  return scasUnit(width);
}

export function repeScasSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(scasUnit(width), "E");
}

export function repneScasSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(scasUnit(width), "NE");
}

function movsUnit(width: OperandWidth): SemanticTemplate {
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

function cmpsUnit(width: OperandWidth): SemanticTemplate {
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

function stosUnit(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const value = s.get(s.reg(accumulator(width)), width);
    const delta = stringDelta(s, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
    stepRegister(s, "edi", delta);
  };
}

function lodsUnit(width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    s.set(s.reg(accumulator(width)), value, width);
    stepRegister(s, "esi", delta);
  };
}

function scasUnit(width: OperandWidth): SemanticTemplate {
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

function repSemantic(unit: SemanticTemplate, condition?: "E" | "NE"): SemanticTemplate {
  return (s, context) => {
    const ecx = s.get(s.reg("ecx"));

    s.jumpIf(s.compare(32, "eq", ecx, s.const32(0)), s.nextEip());
    unit(s, context);

    const decremented = s.binary("sub", ecx, s.const32(1));
    const nonzero = s.compare(32, "ne", decremented, s.const32(0));

    s.set(s.reg("ecx"), decremented);
    s.conditionalJump(repBranchPredicate(s, condition, nonzero), s.currentEip(), s.nextEip());
  };
}

function repBranchPredicate(
  s: SemanticsBuilder,
  condition: "E" | "NE" | undefined,
  nonzero: Value
): Value {
  return condition === undefined
    ? nonzero
    : s.binary("and", nonzero, s.condition(condition));
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
