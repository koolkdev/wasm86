import type { IsaDecodedInstruction } from "#x86/isa/decoder/types.js";
import { createIrVarAllocator, operand } from "#x86/ir/build/builder.js";
import { IrBlockBuilder } from "#x86/ir/build/block.js";
import {
  operandBindingsFromInstruction,
  jitSemanticOperandInfo
} from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitIrBlock, JitIrInstruction } from "#backends/wasm/jit/ir/types.js";
import { bindInstructionIr } from "./instruction-ir.js";

export type AppendInstructionOptions = Readonly<{
  nextMode: "continue" | "exit";
}>;

export class JitBlockBuilder {
  readonly #instructions: JitIrInstruction[] = [];
  readonly #allocator = createIrVarAllocator();

  appendInstruction(
    instruction: IsaDecodedInstruction,
    options: AppendInstructionOptions
  ): void {
    const instructionOperands = operandBindingsFromInstruction(instruction);
    const irBuilder = new IrBlockBuilder({ allocator: this.#allocator });
    const appended = irBuilder.appendInstruction({
      semantics: instruction.spec.semantics,
      operands: instructionOperands.map((_, index) => operand(index)),
      operandInfo: instructionOperands.map(jitSemanticOperandInfo)
    });

    if (options.nextMode === "continue" && appended.terminator !== "next") {
      throw new Error(`non-final JIT IR block instruction must fall through: ${instruction.spec.id}`);
    }

    this.#instructions.push({
      instructionId: instruction.spec.id,
      eip: instruction.address,
      nextEip: instruction.nextEip,
      ir: bindInstructionIr({
        ir: irBuilder.build(),
        operands: instructionOperands,
        nextEip: instruction.nextEip,
        allocator: this.#allocator
      })
    });
  }

  build(): JitIrBlock {
    if (this.#instructions.length === 0) {
      throw new Error("cannot build empty JIT IR block");
    }

    return {
      instructions: [...this.#instructions]
    };
  }
}

export function buildBlock(instructions: readonly IsaDecodedInstruction[]): JitIrBlock {
  if (instructions.length === 0) {
    throw new Error("cannot build empty JIT IR block");
  }

  const builder = new JitBlockBuilder();

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index]!;
    const isLastInstruction = index === instructions.length - 1;

    builder.appendInstruction(instruction, {
      nextMode: isLastInstruction ? "exit" : "continue"
    });
  }

  return builder.build();
}
