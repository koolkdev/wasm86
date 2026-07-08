import { subFlagSource } from "#x86/semantics/flag-writes.js";
import { guardStorageRead, guardStorageWrite } from "#x86/semantics/memory.js";
import type {
  SemanticBuildContext,
  SemanticOps,
  SemanticTemplate,
  Values
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";

type StringUnit = (builder: SemanticOps, values: Values, context: SemanticBuildContext) => void;

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

function movsUnit(width: OperandWidth): StringUnit {
  return (s, v, context) => {
    const src = s.operand(0);
    const dst = s.operand(1);
    const delta = stringDelta(s, v, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);

    stepRegister(s, v, "esi", delta);
    stepRegister(s, v, "edi", delta);
  };
}

function cmpsUnit(width: OperandWidth): StringUnit {
  return (s, v, context) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);
    const delta = stringDelta(s, v, width);

    guardStorageRead(s, context, leftOperand, width);
    guardStorageRead(s, context, rightOperand, width);

    const left = v.truncate(width, s.get(leftOperand, width));
    const right = v.truncate(width, s.get(rightOperand, width));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, v, "esi", delta);
    stepRegister(s, v, "edi", delta);
  };
}

function stosUnit(width: OperandWidth): StringUnit {
  return (s, v, context) => {
    const dst = s.operand(0);
    const value = s.get(s.reg(accumulator(width)), width);
    const delta = stringDelta(s, v, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
    stepRegister(s, v, "edi", delta);
  };
}

function lodsUnit(width: OperandWidth): StringUnit {
  return (s, v, context) => {
    const src = s.operand(0);
    const delta = stringDelta(s, v, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    s.set(s.reg(accumulator(width)), value, width);
    stepRegister(s, v, "esi", delta);
  };
}

function scasUnit(width: OperandWidth): StringUnit {
  return (s, v, context) => {
    const rightOperand = s.operand(0);
    const delta = stringDelta(s, v, width);

    guardStorageRead(s, context, rightOperand, width);

    const left = v.truncate(width, s.get(s.reg(accumulator(width)), width));
    const right = v.truncate(width, s.get(rightOperand, width));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, v, "edi", delta);
  };
}
function repSemantic(
  unit: StringUnit,
  condition?: "E" | "NE"
): SemanticTemplate {
  return (s, v, context) => {
    const ecx = s.get(s.reg("ecx"));
    const enter = v.compare(32, "ne", ecx, v.const(0));

    s.if(enter, (thenBuilder) => {
      thenBuilder.loop((loopBuilder, loopValues) => {
        unit(loopBuilder, loopValues, context);

        const decremented = loopValues.binary(
          "sub",
          loopBuilder.get(loopBuilder.reg("ecx")),
          loopValues.const(1)
        );
        const nonzero = loopValues.compare(32, "ne", decremented, loopValues.const(0));

        loopBuilder.set(loopBuilder.reg("ecx"), decremented);
        return repBranchPredicate(loopBuilder, loopValues, condition, nonzero);
      });
    });

    // Each unit decrements ECX once: entry - exit counts completed units.
    // Instruction completion already charges the REP instruction once; add
    // only the extra completed units beyond the first entered unit.
    const exitEcx = s.get(s.reg("ecx"));
    const completedUnits = v.binary("sub", ecx, exitEcx);

    s.addInstructionCount(v.binary("sub", completedUnits, enter));
  };
}

function repBranchPredicate(
  s: SemanticOps,
  v: Values,
  condition: "E" | "NE" | undefined,
  nonzero: Value
): Value {
  return condition === undefined
    ? nonzero
    : v.binary("and", nonzero, s.condition(condition));
}

function stringDelta(s: SemanticOps, v: Values, width: OperandWidth) {
  const byteLength = width / 8;

  return v.select(s.readFlag("DF"), v.const(-byteLength), v.const(byteLength));
}

function stepRegister(s: SemanticOps, v: Values, reg: "esi" | "edi", delta: ReturnType<typeof stringDelta>): void {
  s.set(s.reg(reg), v.binary("add", s.get(s.reg(reg), 32), delta), 32);
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
