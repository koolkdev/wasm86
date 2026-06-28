import type { SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import {
  addFlagSource,
  logicFlagSource,
  subFlagSource,
  writeAddFlags,
  writeDecFlags,
  writeIncFlags,
  writeNegFlags,
  writeSubFlags
} from "./flag-writes.js";
import { guardStorageRead, guardStorageReadWrite } from "./memory.js";

export type AluOp = "add" | "adc" | "sub" | "sbb" | "xor" | "and" | "or";
export type UnaryAluOp = "inc" | "dec" | "not" | "neg";

export function aluSemantic(op: AluOp, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, context, dst, width);
    guardStorageRead(s, context, src, width);

    const left = s.project(width, s.get(dst, width));
    const right = s.project(width, s.get(src, width));

    switch (op) {
      case "add": {
        const result = s.project(width, s.i32Add(left, right));

        s.writeStatusFlagsSource(addFlagSource({ width, left, right, result }));
        s.set(dst, result, width);
        return;
      }
      case "sub": {
        const result = s.project(width, s.i32Sub(left, right));

        s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
        s.set(dst, result, width);
        return;
      }
      case "xor":
      case "and":
      case "or": {
        const result = s.project(width, logicResult(s, op, left, right));

        s.writeStatusFlagsSource(logicFlagSource({ width, result }));
        s.set(dst, result, width);
        return;
      }
      case "adc": {
        const oldCf = s.readFlag("CF");
        const result = s.project(width, s.i32Add(s.i32Add(left, right), oldCf));

        writeAddFlags(s, { width, left, right, result, carryIn: oldCf });
        s.set(dst, result, width);
        return;
      }
      case "sbb": {
        const oldCf = s.readFlag("CF");
        const result = s.project(width, s.i32Sub(s.i32Sub(left, right), oldCf));

        writeSubFlags(s, { width, left, right, result, borrowIn: oldCf });
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

function logicResult(s: SemanticsBuilder, op: "and" | "or" | "xor", left: Value, right: Value): Value {
  switch (op) {
    case "and":
      return s.i32And(left, right);
    case "or":
      return s.i32Or(left, right);
    case "xor":
      return s.i32Xor(left, right);
  }
}
