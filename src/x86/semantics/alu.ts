import type { Values } from "#ir/values.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
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
  return (s, v, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, v, context, dst, width);
    guardStorageRead(s, v, context, src, width);

    const left = v.truncate(width, s.get(dst, width));
    const right = v.truncate(width, s.get(src, width));

    switch (op) {
      case "add": {
        const result = v.truncate(width, v.binary("add", left, right));

        s.writeStatusFlagsSource(addFlagSource({ width, left, right, result }));
        s.set(dst, result, width);
        return;
      }
      case "sub": {
        const result = v.truncate(width, v.binary("sub", left, right));

        s.writeStatusFlagsSource(subFlagSource({ width, left, right, result }));
        s.set(dst, result, width);
        return;
      }
      case "xor":
      case "and":
      case "or": {
        const result = v.truncate(width, logicResult(v, op, left, right));

        s.writeStatusFlagsSource(logicFlagSource({ width, result }));
        s.set(dst, result, width);
        return;
      }
      case "adc": {
        const oldCf = s.readFlag("CF");
        const result = v.truncate(width, v.binary("add", v.binary("add", left, right), oldCf));

        writeAddFlags(s, v, { width, left, right, result, carryIn: oldCf });
        s.set(dst, result, width);
        return;
      }
      case "sbb": {
        const oldCf = s.readFlag("CF");
        const result = v.truncate(width, v.binary("sub", v.binary("sub", left, right), oldCf));

        writeSubFlags(s, v, { width, left, right, result, borrowIn: oldCf });
        s.set(dst, result, width);
        return;
      }
    }
  };
}

export function unaryAluSemantic(op: UnaryAluOp, width: OperandWidth): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);

    guardStorageReadWrite(s, v, context, dst, width);

    const value = s.get(dst, width);
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

    s.set(dst, result, width);
  };
}

function logicResult(v: Values, op: "and" | "or" | "xor", left: Value, right: Value): Value {
  switch (op) {
    case "and":
      return v.binary("and", left, right);
    case "or":
      return v.binary("or", left, right);
    case "xor":
      return v.binary("xor", left, right);
  }
}
