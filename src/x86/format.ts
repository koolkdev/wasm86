import type { IsaDecodedInstruction, IsaOperandBinding } from "./decoder/types.js";

export function formatIsaInstruction(instruction: IsaDecodedInstruction): string {
  return instruction.spec.format.syntax.replace(/\{([^{}]+)\}/g, (_match, placeholder: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(placeholder)) {
      throw new Error(`format placeholder {${placeholder}} must be an operand index`);
    }

    const operand = instruction.operands[Number(placeholder)];

    if (operand === undefined) {
      throw new Error(`format placeholder {${placeholder}} does not match a decoded operand`);
    }

    return formatIsaOperand(operand);
  });
}

export function formatIsaOperand(operand: IsaOperandBinding): string {
  switch (operand.kind) {
    case "reg":
      return operand.alias.name;
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

  return `[${terms.join(" + ")}]`;
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}
