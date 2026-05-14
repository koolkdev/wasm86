import type { SemanticTemplate } from "#x86/ir/model/types.js";
import { widthMask, type OperandWidth } from "#x86/isa/types.js";
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
    let result;

    switch (op) {
      case "add":
        result = s.i32Add(left, right);
        s.setFlags("add", { left, right, result }, width);
        break;
      case "sub":
        result = s.i32Sub(left, right);
        s.setFlags("sub", { left, right, result }, width);
        break;
      case "xor":
        result = s.i32Xor(left, right);
        s.setFlags("logic", { result }, width);
        break;
      case "and":
        result = s.i32And(left, right);
        s.setFlags("logic", { result }, width);
        break;
      case "or":
        result = s.i32Or(left, right);
        s.setFlags("logic", { result }, width);
        break;
    }

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
        s.setFlags("inc", { left: value, result }, width);
        break;
      case "dec":
        result = s.i32Sub(value, s.const32(1));
        s.setFlags("dec", { left: value, result }, width);
        break;
      case "not":
        result = s.i32Xor(value, s.const32(widthMask(width)));
        break;
      case "neg": {
        const zero = s.const32(0);

        result = s.i32Sub(zero, value);
        s.setFlags("sub", { left: zero, right: value, result }, width);
        break;
      }
    }

    s.set(dst, result, width);
  };
}
