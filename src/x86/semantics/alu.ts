import type { IrBuilder, SemanticTemplate, ValueRef } from "#ir/model/types.js";
import { widthMask, type OperandWidth } from "#x86/types.js";
import {
  buildAddResultAndFlags,
  buildDecFlags,
  buildIncFlags,
  buildLogicResultAndFlags,
  buildNegFlags,
  buildSubResultAndFlags,
  type ResultAndFlags
} from "./flag-helpers.js";
import { guardStorageRead, guardStorageReadWrite } from "./memory.js";

export type AluOp = "add" | "sub" | "xor" | "and" | "or";
export type UnaryAluOp = "inc" | "dec" | "not" | "neg";

export function aluSemantic(op: AluOp, width: OperandWidth): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageReadWrite(s, context, dst, width);
    guardStorageRead(s, context, src, width);

    const left = s.get(dst, width);
    const right = s.get(src, width);
    const { result, flags } = aluResultAndFlags(s, op, width, left, right);

    s.writeFlags(flags);
    s.set(dst, result, width);
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
        s.writeFlags(buildIncFlags(s, { width, input: value, result }));
        break;
      case "dec":
        result = s.i32Sub(value, s.const32(1));
        s.writeFlags(buildDecFlags(s, { width, input: value, result }));
        break;
      case "not":
        result = s.i32Xor(value, s.const32(widthMask(width)));
        break;
      case "neg":
        result = s.i32Sub(s.const32(0), value);
        s.writeFlags(buildNegFlags(s, { width, input: value, result }));
        break;
    }

    s.set(dst, result, width);
  };
}

function aluResultAndFlags(
  s: IrBuilder,
  op: AluOp,
  width: OperandWidth,
  left: ValueRef,
  right: ValueRef
): ResultAndFlags {
  switch (op) {
    case "add":
      return buildAddResultAndFlags(s, { width, left, right });
    case "sub":
      return buildSubResultAndFlags(s, { width, left, right });
    case "xor":
    case "and":
    case "or":
      return buildLogicResultAndFlags(s, { width, op, left, right });
  }
}
