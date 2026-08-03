import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import type { Value } from "#instructions/semantics/refs.js";
import { widthMask, type OperandWidth } from "#core/types.js";
import { addFlagSource, logicFlagSource, subFlagSource } from "#core/flags/lazy/sources.js";
import {
  writeAddFlags,
  writeDecFlags,
  writeIncFlags,
  writeNegFlags,
  writeSubFlags
} from "./flag-writes.js";

export type AluOp = "add" | "adc" | "sub" | "sbb" | "xor" | "and" | "or";
export type UnaryAluOp = "inc" | "dec" | "not" | "neg";

export function aluSemantic(op: AluOp, width: OperandWidth): InstructionSemantics {
  return (s, v) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const destination = s.update(dst, { width });
    const left = v.truncate(width, destination.read(s));
    const right = v.truncate(width, s.read(src, { width }));

    switch (op) {
      case "add": {
        const result = v.truncate(width, v.binary("add", left, right));

        s.writeStatusFlagsSource(addFlagSource({ width, left, right, result }));
        destination.write(s, result);
        return;
      }
      case "sub": {
        const result = v.truncate(width, v.binary("sub", left, right));

        s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
        destination.write(s, result);
        return;
      }
      case "xor":
      case "and":
      case "or": {
        const result = v.truncate(width, logicResult(v, op, left, right));

        s.writeStatusFlagsSource(logicFlagSource({ width, result }));
        destination.write(s, result);
        return;
      }
      case "adc": {
        const oldCf = s.readFlag("CF");
        const result = v.truncate(width, v.binary("add", v.binary("add", left, right), oldCf));

        writeAddFlags(s, v, { width, left, right, result, carryIn: oldCf });
        destination.write(s, result);
        return;
      }
      case "sbb": {
        const oldCf = s.readFlag("CF");
        const result = v.truncate(width, v.binary("sub", v.binary("sub", left, right), oldCf));

        writeSubFlags(s, v, { width, left, right, result, borrowIn: oldCf });
        destination.write(s, result);
        return;
      }
    }
  };
}

export function unaryAluSemantic(op: UnaryAluOp, width: OperandWidth): InstructionSemantics {
  return (s, v) => {
    const dst = s.operand(0);
    const destination = s.update(dst, { width });
    const value = destination.read(s);
    let result;

    switch (op) {
      case "inc":
        result = v.binary("add", value, v.const(1));
        writeIncFlags(s, v, { width, input: value, result });
        break;
      case "dec":
        result = v.binary("sub", value, v.const(1));
        writeDecFlags(s, v, { width, input: value, result });
        break;
      case "not":
        result = v.binary("xor", value, v.const(widthMask(width)));
        break;
      case "neg":
        result = v.binary("sub", v.const(0), value);
        writeNegFlags(s, v, { width, input: value, result });
        break;
    }

    destination.write(s, result);
  };
}

function logicResult(v: ValueBuilder, op: "and" | "or" | "xor", left: Value, right: Value): Value {
  switch (op) {
    case "and":
      return v.binary("and", left, right);
    case "or":
      return v.binary("or", left, right);
    case "xor":
      return v.binary("xor", left, right);
  }
}
