import { subFlagSource } from "#x86/semantics/flag-writes.js";
import { guardStorageRead, guardStorageWrite } from "#x86/semantics/memory.js";
import type {
  LoopOptions,
  SemanticBuildContext,
  SemanticOps,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";

type StringUnit = (builder: SemanticOps, context: SemanticBuildContext) => void;

export function movsSemantic(width: OperandWidth): SemanticTemplate {
  return movsUnit(width);
}

export function repMovsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(movsUnit(width), { stateRegs: ["ecx", "esi", "edi"] });
}

export function cmpsSemantic(width: OperandWidth): SemanticTemplate {
  return cmpsUnit(width);
}

export function repeCmpsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(cmpsUnit(width), { stateRegs: ["ecx", "esi", "edi"], statusFlags: true }, "E");
}

export function repneCmpsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(cmpsUnit(width), { stateRegs: ["ecx", "esi", "edi"], statusFlags: true }, "NE");
}

export function stosSemantic(width: OperandWidth): SemanticTemplate {
  return stosUnit(width);
}

export function repStosSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(stosUnit(width), { stateRegs: ["ecx", "edi"] });
}

export function lodsSemantic(width: OperandWidth): SemanticTemplate {
  return lodsUnit(width);
}

export function repLodsSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(lodsUnit(width), {
    stateRegs: ["ecx", "esi", accumulator(width)]
  });
}

export function scasSemantic(width: OperandWidth): SemanticTemplate {
  return scasUnit(width);
}

export function repeScasSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(scasUnit(width), { stateRegs: ["ecx", "edi"], statusFlags: true }, "E");
}

export function repneScasSemantic(width: OperandWidth): SemanticTemplate {
  return repSemantic(scasUnit(width), { stateRegs: ["ecx", "edi"], statusFlags: true }, "NE");
}

function movsUnit(width: OperandWidth): StringUnit {
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

function cmpsUnit(width: OperandWidth): StringUnit {
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

function stosUnit(width: OperandWidth): StringUnit {
  return (s, context) => {
    const dst = s.operand(0);
    const value = s.get(s.reg(accumulator(width)), width);
    const delta = stringDelta(s, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
    stepRegister(s, "edi", delta);
  };
}

function lodsUnit(width: OperandWidth): StringUnit {
  return (s, context) => {
    const src = s.operand(0);
    const delta = stringDelta(s, width);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    s.set(s.reg(accumulator(width)), value, width);
    stepRegister(s, "esi", delta);
  };
}

function scasUnit(width: OperandWidth): StringUnit {
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
function repSemantic(
  unit: StringUnit,
  loop: Omit<LoopOptions, "enter" | "body">,
  condition?: "E" | "NE"
): SemanticTemplate {
  return (s, context) => {
    const ecx = s.get(s.reg("ecx"));
    const enter = s.compare(32, "ne", ecx, s.const32(0));

    s.loop({
      ...loop,
      enter,
      body: (loopBuilder) => {
        unit(loopBuilder, context);

        const decremented = loopBuilder.binary(
          "sub",
          loopBuilder.get(loopBuilder.reg("ecx")),
          loopBuilder.const32(1)
        );
        const nonzero = loopBuilder.compare(32, "ne", decremented, loopBuilder.const32(0));

        loopBuilder.set(loopBuilder.reg("ecx"), decremented);
        return repBranchPredicate(loopBuilder, condition, nonzero);
      }
    });

    // Each unit decrements ECX once: entry − exit counts completed units.
    // Minus enter cancels next()'s +1 on the ran path; a zero trip adds 0.
    const exitEcx = s.get(s.reg("ecx"));

    s.addInstructionCount(s.binary("sub", s.binary("sub", ecx, exitEcx), enter));
  };
}

function repBranchPredicate(
  s: SemanticOps,
  condition: "E" | "NE" | undefined,
  nonzero: Value
): Value {
  return condition === undefined
    ? nonzero
    : s.binary("and", nonzero, s.condition(condition));
}

function stringDelta(s: SemanticOps, width: OperandWidth) {
  const byteLength = width / 8;

  return s.select(s.readFlag("DF"), s.const32(-byteLength), s.const32(byteLength));
}

function stepRegister(s: SemanticOps, reg: "esi" | "edi", delta: ReturnType<typeof stringDelta>): void {
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
