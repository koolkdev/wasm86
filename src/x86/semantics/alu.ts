import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import {
  buildAddResultAndFlagSource,
  buildAddResultAndWriteFlags,
  buildLogicResultAndFlagSource,
  buildSubResultAndFlagSource,
  buildSubResultAndWriteFlags,
  writeDecFlags,
  writeIncFlags,
  writeNegFlags
} from "./alu-flags.js";
import { guardStorageRead, guardStorageReadWrite } from "./memory.js";

export type AluOp = "add" | "adc" | "sub" | "sbb" | "xor" | "and" | "or";
export type UnaryAluOp = "inc" | "dec" | "not" | "neg";

export function aluSemantic(op: AluOp, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, context, dst, width);
    guardStorageRead(s, context, src, width);

    const left = s.get(dst, width);
    const right = s.get(src, width);

    switch (op) {
      case "add": {
        const { result, source } = buildAddResultAndFlagSource(s, { width, left, right });

        s.writeStatusFlagsSource(source);
        s.set(dst, result, width);
        return;
      }
      case "sub": {
        const { result, source } = buildSubResultAndFlagSource(s, { width, left, right });

        s.writeStatusFlagsSource(source);
        s.set(dst, result, width);
        return;
      }
      case "xor":
      case "and":
      case "or": {
        const { result, source } = buildLogicResultAndFlagSource(s, { width, op, left, right });

        s.writeStatusFlagsSource(source);
        s.set(dst, result, width);
        return;
      }
      case "adc": {
        const oldCf = s.readFlag("CF");
        const result = buildAddResultAndWriteFlags(s, { width, left, right, carryIn: oldCf });

        s.set(dst, result, width);
        return;
      }
      case "sbb": {
        const oldCf = s.readFlag("CF");
        const result = buildSubResultAndWriteFlags(s, { width, left, right, borrowIn: oldCf });

        s.set(dst, result, width);
        return;
      }
    }
  };
}

export function unaryAluSemantic(op: UnaryAluOp, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, context, dst, width);

    const value = s.get(dst, width);
    let result;

    switch (op) {
      case "inc":
        result = s.i32Add(value, s.const32(1));
        writeIncFlags(s, { width, input: value, result });
        break;
      case "dec":
        result = s.i32Sub(value, s.const32(1));
        writeDecFlags(s, { width, input: value, result });
        break;
      case "not":
        result = s.i32Xor(value, s.const32(widthMask(width)));
        break;
      case "neg":
        result = s.i32Sub(s.const32(0), value);
        writeNegFlags(s, { width, input: value, result });
        break;
    }

    s.set(dst, result, width);
  };
}
