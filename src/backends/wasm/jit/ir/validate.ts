import { validateIrBlock } from "#x86/ir/passes/validator.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export function validateJitIrBlock(block: JitIrBlock): void {
  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction: ${instructionIndex}`);
    }

    try {
      validateJitInstructionBody(instruction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(`invalid JIT IR at instruction ${instructionIndex}: ${message}`);
    }
  }
}

function validateJitInstructionBody(
  instruction: JitIrBlockInstruction
): void {
  validateIrBlock(instruction.ir, {
    operandCount: instruction.operands.length,
    terminatorMode: "single"
  });
}
