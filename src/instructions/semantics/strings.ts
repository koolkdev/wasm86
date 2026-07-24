import { subFlagSource } from "#core/flags/lazy/sources.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticOps,
  SemanticTemplate
} from "#instructions/semantics/builder.js";
import type { Value } from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";

type StringUnit = (builder: SemanticOps, values: ValueBuilder) => void;

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
  return (s, v) => {
    const src = s.operand(0);
    const dst = s.operand(1);
    const delta = stringDelta(s, v, width);

    const value = s.read(src, { width });

    s.write(dst, value, { width });

    stepRegister(s, v, "esi", delta);
    stepRegister(s, v, "edi", delta);
  };
}

function cmpsUnit(width: OperandWidth): StringUnit {
  return (s, v) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);
    const delta = stringDelta(s, v, width);

    const left = v.truncate(width, s.read(leftOperand, { width }));
    const right = v.truncate(width, s.read(rightOperand, { width }));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, v, "esi", delta);
    stepRegister(s, v, "edi", delta);
  };
}

function stosUnit(width: OperandWidth): StringUnit {
  return (s, v) => {
    const dst = s.operand(0);
    const value = s.read(s.reg(accumulator(width)), { width });
    const delta = stringDelta(s, v, width);

    s.write(dst, value, { width });
    stepRegister(s, v, "edi", delta);
  };
}

function lodsUnit(width: OperandWidth): StringUnit {
  return (s, v) => {
    const src = s.operand(0);
    const delta = stringDelta(s, v, width);

    const value = s.read(src, { width });

    s.write(s.reg(accumulator(width)), value, { width });
    stepRegister(s, v, "esi", delta);
  };
}

function scasUnit(width: OperandWidth): StringUnit {
  return (s, v) => {
    const rightOperand = s.operand(0);
    const delta = stringDelta(s, v, width);

    const left = v.truncate(width, s.read(s.reg(accumulator(width)), { width }));
    const right = v.truncate(width, s.read(rightOperand, { width }));
    const result = v.truncate(width, v.binary("sub", left, right));

    s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
    stepRegister(s, v, "edi", delta);
  };
}
function repSemantic(
  unit: StringUnit,
  condition?: "E" | "NE"
): SemanticTemplate {
  return (s, v) => {
    const ecx = s.read(s.reg("ecx"), { width: 32 });
    const enter = v.compare(32, "ne", ecx, v.const(0));

    s.if(enter, (thenBuilder) => {
      thenBuilder.loop((loopBuilder, loopValues) => {
        unit(loopBuilder, loopValues);

        const decremented = loopValues.binary(
          "sub",
          loopBuilder.read(loopBuilder.reg("ecx"), { width: 32 }),
          loopValues.const(1)
        );
        const nonzero = loopValues.compare(32, "ne", decremented, loopValues.const(0));

        loopBuilder.write(loopBuilder.reg("ecx"), decremented, { width: 32 });
        return repBranchPredicate(loopBuilder, loopValues, condition, nonzero);
      });
    });

    // Each unit decrements ECX once: entry - exit counts completed units.
    // Instruction completion already charges the REP instruction once; add
    // only the extra completed units beyond the first entered unit.
    const exitEcx = s.read(s.reg("ecx"), { width: 32 });
    const completedUnits = v.binary("sub", ecx, exitEcx);

    s.addInstructionCount(v.binary("sub", completedUnits, enter));
  };
}

function repBranchPredicate(
  s: SemanticOps,
  v: ValueBuilder,
  condition: "E" | "NE" | undefined,
  nonzero: Value
): Value {
  return condition === undefined
    ? nonzero
    : v.binary("and", nonzero, s.condition(condition));
}

function stringDelta(s: SemanticOps, v: ValueBuilder, width: OperandWidth) {
  const byteLength = width / 8;

  return v.select(s.readFlag("DF"), v.const(-byteLength), v.const(byteLength));
}

function stepRegister(s: SemanticOps, v: ValueBuilder, reg: "esi" | "edi", delta: ReturnType<typeof stringDelta>): void {
  s.write(
    s.reg(reg),
    v.binary("add", s.read(s.reg(reg), { width: 32 }), delta),
    { width: 32 }
  );
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
