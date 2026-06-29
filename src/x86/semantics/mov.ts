import type { ConditionCode } from "#x86/conditions.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandWidth } from "#x86/types.js";
import { guardStorageRead, guardStorageWrite } from "./memory.js";

export function movSemantic(width: OperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
  };
}

export function movSregSemantic(registerWidth: Extract<OperandWidth, 16 | 32>): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);
    const width = context.operandInfo(dst).storage === "mem" ? 16 : registerWidth;

    guardStorageRead(s, context, src, width);
    const value = s.get(src, width);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, value, width);
  };
}

export function movzxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, sourceWidth);
    const value = s.get(src, sourceWidth);

    guardStorageWrite(s, context, dst, destinationWidth);
    s.set(dst, value, destinationWidth);
  };
}

export function movsxSemantic(sourceWidth: 8 | 16, destinationWidth: 16 | 32): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, sourceWidth);
    const value = s.get(src, sourceWidth, { signed: true });

    guardStorageWrite(s, context, dst, destinationWidth);
    s.set(dst, value, destinationWidth);
  };
}

export function cmovSemantic(cc: ConditionCode, width: OperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const src = s.operand(1);

    guardStorageRead(s, context, src, width);
    guardStorageRead(s, context, dst, width);

    const value = s.get(src, width);
    const condition = s.condition(cc);
    const fallback = s.get(dst, width);
    const selected = s.select(condition, value, fallback);

    guardStorageWrite(s, context, dst, width);
    s.set(dst, selected, width);
  };
}
