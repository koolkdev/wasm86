import { X86_32_CORE } from "#x86/index.js";
import { buildOpcodeDispatch, type OpcodeDispatchNode } from "#x86/decoder/opcode-dispatch.js";
import { expandInstructionSpec } from "#x86/schema/builders.js";
import { registerAlias } from "#x86/registers.js";
import type { InstructionSpec, OperandSpec } from "#x86/schema/types.js";

export const interpreterOpcodeDispatchRoot: OpcodeDispatchNode = buildOpcodeDispatch(
  X86_32_CORE.instructions.filter(interpreterSupportsInstruction).flatMap((spec) => expandInstructionSpec(spec))
);

export function dispatchBytes(node: OpcodeDispatchNode): number[] {
  const bytes: number[] = [];

  for (let byte = 0; byte <= 0xff; byte += 1) {
    if (node.next[byte] !== undefined) {
      bytes.push(byte);
    }
  }

  return bytes;
}

function interpreterSupportsInstruction(spec: InstructionSpec): boolean {
  return (
    (spec.prefixes === undefined || spec.prefixes.operandSize !== undefined) &&
    (spec.operands ?? []).every(interpreterSupportsOperand)
  );
}

function interpreterSupportsOperand(operand: OperandSpec): boolean {
  switch (operand.kind) {
    case "modrm.reg":
    case "opcode.reg":
      return operand.type === "r8" || operand.type === "r16" || operand.type === "r32";
    case "modrm.rm":
      return (
        operand.type === "rm8" ||
        operand.type === "rm16" ||
        operand.type === "rm32" ||
        operand.type === "m8" ||
        operand.type === "m16" ||
        operand.type === "m32"
      );
    case "implicit.reg":
      return registerAlias(operand.reg).width === 8 ||
        registerAlias(operand.reg).width === 16 ||
        registerAlias(operand.reg).width === 32;
    case "imm":
    case "rel":
      return true;
  }
}
