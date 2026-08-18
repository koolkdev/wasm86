import { i32, select, type I32Value } from "#compiler/function/values.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import type { SemanticOps, InstructionSemantics } from "#instructions/semantics/builder.js";
import type { OperandWidth } from "#core/types.js";
import { accumulator } from "./registers.js";

type StringIteration = (s: SemanticOps) => void;

export function movsSemantic<Width extends OperandWidth>(width: Width): StringIteration {
  return (s) => {
    const src = s.operand(0);
    const dst = s.operand(1);
    const value = s.read(src, width);
    const delta = stringDelta(s, width);

    s.write(dst, value);
    stepRegister(s, "esi", delta);
    stepRegister(s, "edi", delta);
  };
}

export function repMovsSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(movsSemantic(width));
}

export function cmpsSemantic<Width extends OperandWidth>(width: Width): StringIteration {
  return (s) => {
    const leftOperand = s.operand(0);
    const rightOperand = s.operand(1);
    const left = s.read(leftOperand, width);
    const right = s.read(rightOperand, width);
    const result = left.sub(right);
    const delta = stringDelta(s, width);

    s.writeStatusFlagsSource(subFlagSource({ left, right, result }));
    stepRegister(s, "esi", delta);
    stepRegister(s, "edi", delta);
  };
}

export function repeCmpsSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(cmpsSemantic(width), "E");
}

export function repneCmpsSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(cmpsSemantic(width), "NE");
}

export function stosSemantic<Width extends OperandWidth>(width: Width): StringIteration {
  return (s) => {
    const dst = s.operand(0);
    const value = s.read(accumulator(width));
    const delta = stringDelta(s, width);

    s.write(dst, value);
    stepRegister(s, "edi", delta);
  };
}

export function repStosSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(stosSemantic(width));
}

export function lodsSemantic<Width extends OperandWidth>(width: Width): StringIteration {
  return (s) => {
    const src = s.operand(0);
    const value = s.read(src, width);
    const delta = stringDelta(s, width);

    s.write(accumulator(width), value);
    stepRegister(s, "esi", delta);
  };
}

export function repLodsSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(lodsSemantic(width));
}

export function scasSemantic<Width extends OperandWidth>(width: Width): StringIteration {
  return (s) => {
    const rightOperand = s.operand(0);
    const left = s.read(accumulator(width));
    const right = s.read(rightOperand, width);
    const result = left.sub(right);
    const delta = stringDelta(s, width);

    s.writeStatusFlagsSource(subFlagSource({ left, right, result }));
    stepRegister(s, "edi", delta);
  };
}

export function repeScasSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(scasSemantic(width), "E");
}

export function repneScasSemantic(width: OperandWidth): InstructionSemantics {
  return repSemantic(scasSemantic(width), "NE");
}

function repSemantic(unit: StringIteration, condition?: "E" | "NE"): InstructionSemantics {
  return (s) => {
    const ecx = s.read(s.reg("ecx"));
    const enter = ecx.ne(0);

    s.if(enter, (then) => {
      then.loop((loop) => {
        unit(loop);

        const decremented = loop.read(loop.reg("ecx")).sub(1);
        const nonzero = decremented.ne(0);

        loop.write(loop.reg("ecx"), decremented);
        return condition === undefined ? nonzero : nonzero.and(loop.condition(condition));
      });
    });

    // Each unit decrements ECX once: entry - exit counts completed units.
    // Instruction completion already charges the REP instruction once; add
    // only the extra completed units beyond the first entered unit.
    const exitEcx = s.read(s.reg("ecx"));
    const completedUnits = ecx.sub(exitEcx);

    s.addInstructionCount(completedUnits.sub(enter.unsigned.extend(32)));
  };
}

function stringDelta(s: SemanticOps, width: OperandWidth): I32Value {
  const byteLength = width / 8;

  return select(s.readFlag("DF"), i32(-byteLength), i32(byteLength));
}

function stepRegister(s: SemanticOps, reg: "esi" | "edi", delta: I32Value): void {
  const target = s.reg(reg);

  s.write(target, s.read(target).add(delta));
}
