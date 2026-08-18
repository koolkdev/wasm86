import { integer } from "#compiler/function/values.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
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
  return (s) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const destination = s.update(dst, width);
    const left = s.read(destination);
    const right = s.read(src, width);

    switch (op) {
      case "add": {
        const result = left.add(right);

        s.writeStatusFlagsSource(addFlagSource({ left, right, result }));
        s.write(destination, result);
        return;
      }
      case "sub": {
        const result = left.sub(right);

        s.writeStatusFlagsSource(subFlagSource({ left, right, result }));
        s.write(destination, result);
        return;
      }
      case "xor":
      case "and":
      case "or": {
        const result = left[op](right);

        s.writeStatusFlagsSource(logicFlagSource({ result }));
        s.write(destination, result);
        return;
      }
      case "adc": {
        const oldCf = s.readFlag("CF");
        const result = left.addWithCarry(right, oldCf);

        writeAddFlags(s, { left, right, result, carryIn: oldCf });
        s.write(destination, result);
        return;
      }
      case "sbb": {
        const oldCf = s.readFlag("CF");
        const result = left.subWithBorrow(right, oldCf);

        writeSubFlags(s, { left, right, result, borrowIn: oldCf });
        s.write(destination, result);
        return;
      }
    }
  };
}

export function unaryAluSemantic(op: UnaryAluOp, width: OperandWidth): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const destination = s.update(dst, width);
    const value = s.read(destination);
    let result;

    switch (op) {
      case "inc":
        result = value.add(1);
        writeIncFlags(s, { input: value, result });
        break;
      case "dec":
        result = value.sub(1);
        writeDecFlags(s, { input: value, result });
        break;
      case "not":
        result = value.xor(widthMask(width));
        break;
      case "neg":
        result = integer(width, 0).sub(value);
        writeNegFlags(s, { input: value, result });
        break;
    }

    s.write(destination, result);
  };
}
