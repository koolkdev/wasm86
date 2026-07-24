import { assert } from "#common/assert.js";

import type { IsaDecodedInstruction, IsaOperandBinding } from "./decoder/types.js";
import { defaultSegmentForBase } from "#core/segments.js";

const formatPlaceholderPattern = /\{([^{}]+)\}/g;

export function formatIsaInstruction(instruction: IsaDecodedInstruction): string {
  return instruction.spec.syntax.replace(formatPlaceholderPattern, (match: string) => {
    const placeholder = formatPlaceholders(match)[0];

    assert(placeholder !== undefined, "format placeholder parser produced no placeholder");

    const operand = instruction.operands[placeholder];

    assert(
      operand !== undefined,
      `format placeholder {${placeholder}} does not match a decoded operand`
    );

    return formatIsaOperand(operand);
  });
}

export function formatPlaceholders(syntax: string): readonly number[] {
  return [...syntax.matchAll(formatPlaceholderPattern)].map((match) => {
    const placeholder = match[1];

    assert(placeholder !== undefined, "format placeholder parser produced an empty capture");

    assert(
      /^(0|[1-9][0-9]*)$/.test(placeholder),
      `format placeholder {${placeholder}} must be an operand index`
    );

    return Number(placeholder);
  });
}

export function formatIsaOperand(operand: IsaOperandBinding): string {
  switch (operand.kind) {
    case "reg":
      return operand.alias.name;
    case "segment":
      return operand.reg;
    case "imm":
      return hex32(operand.value);
    case "relTarget":
      return hex32(operand.target);
    case "mem":
      return formatMemOperand(operand);
  }
}

function formatMemOperand(operand: Extract<IsaOperandBinding, { kind: "mem" }>): string {
  const terms: string[] = [];

  if (operand.base !== undefined) {
    terms.push(operand.base);
  }

  if (operand.index !== undefined) {
    terms.push(operand.scale === 1 ? operand.index : `${operand.index}*${operand.scale}`);
  }

  if (operand.disp !== 0 || terms.length === 0) {
    terms.push(hex32(operand.disp));
  }

  const formatted = `[${terms.join(" + ")}]`;
  const defaultSegment = defaultSegmentForBase(operand.base);

  return operand.segment === undefined || operand.segment === defaultSegment
    ? formatted
    : `${operand.segment}:${formatted}`;
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}
