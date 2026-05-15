import { validateIrBlock } from "#x86/ir/passes/validator.js";
import { irOpIsTerminator } from "#x86/ir/model/op-semantics.js";
import type { IrOp } from "#x86/ir/model/types.js";
import type { JitBlock, JitInstruction } from "#backends/wasm/jit/ir/types.js";

export function validateBlock(block: JitBlock): void {
  if (block.instructions.length === 0) {
    throw new Error("cannot validate empty JIT block");
  }

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction: ${instructionIndex}`);
    }

    try {
      validateJitInstructionBody(instruction);
      validateInstructionBoundary(block, instruction, instructionIndex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(`invalid JIT IR at instruction ${instructionIndex}: ${message}`);
    }
  }
}

function validateJitInstructionBody(
  instruction: JitInstruction
): void {
  validateIrBlock(instruction.ir, {
    operandCount: instruction.operands.length,
    terminatorMode: "single"
  });
}

function validateInstructionBoundary(
  block: JitBlock,
  instruction: JitInstruction,
  instructionIndex: number
): void {
  const terminator = instruction.ir[instruction.ir.length - 1];

  if (terminator === undefined || !irOpIsTerminator(terminator)) {
    throw new Error("JIT instruction IR must end with a terminator");
  }

  if (instructionIndex === block.instructions.length - 1) {
    if (instruction.nextMode !== "exit") {
      throw new Error("final JIT instruction must exit");
    }

    return;
  }

  if (instructionIndex < block.instructions.length - 1) {
    if (instruction.nextMode !== "continue") {
      throw new Error("non-final JIT instruction must continue");
    }

    if (!isFallthroughTerminator(terminator)) {
      throw new Error(`non-final JIT instruction must fall through, got ${terminator.op}`);
    }
  }
}

function isFallthroughTerminator(op: IrOp): boolean {
  return op.op === "next";
}
