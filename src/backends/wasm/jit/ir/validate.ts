import { validateIrBlock } from "#x86/ir/passes/validator.js";
import {
  irOpDst,
  irOpIsTerminator,
  visitIrOpStorageRefs,
  visitIrOpValueRefs
} from "#x86/ir/model/op-semantics.js";
import type { IrOp, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrInstruction } from "#backends/wasm/jit/ir/types.js";

type VarDefinition = Readonly<{
  instructionIndex: number;
  opIndex: number;
}>;

export function validateBlock(block: JitIrBlock): void {
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

  validateBlockVarNamespace(block);
}

export function validateBlockVarNamespace(block: JitIrBlock): void {
  const definitions = new Map<number, VarDefinition>();

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction: ${instructionIndex}`);
    }

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op at instruction ${instructionIndex}:${opIndex}`);
      }

      const dst = irOpDst(op);

      if (dst === undefined) {
        continue;
      }

      const previous = definitions.get(dst.id);

      if (previous !== undefined) {
        throw new Error(
          `JIT block var ${dst.id} is assigned more than once ` +
          `(${varDefinitionLabel(previous)} and ${varDefinitionLabel({ instructionIndex, opIndex })})`
        );
      }

      definitions.set(dst.id, { instructionIndex, opIndex });
    }
  }
}

function validateJitInstructionBody(
  instruction: JitIrInstruction
): void {
  validateIrBlock(instruction.ir, {
    terminatorMode: "single"
  });

  for (const op of instruction.ir) {
    validateJitInstructionOp(op);
  }
}

function validateInstructionBoundary(
  block: JitIrBlock,
  instruction: JitIrInstruction,
  instructionIndex: number
): void {
  const terminator = instruction.ir[instruction.ir.length - 1];

  if (terminator === undefined || !irOpIsTerminator(terminator)) {
    throw new Error("JIT instruction IR must end with a terminator");
  }

  if (instructionIndex === block.instructions.length - 1) {
    return;
  }

  if (instructionIndex < block.instructions.length - 1) {
    if (!isFallthroughTerminator(terminator)) {
      throw new Error(`non-final JIT instruction must fall through, got ${terminator.op}`);
    }

    const nextInstruction = block.instructions[instructionIndex + 1];

    if (nextInstruction === undefined) {
      throw new Error(`missing JIT instruction: ${instructionIndex + 1}`);
    }

    if (instruction.nextEip !== nextInstruction.eip) {
      throw new Error(
        `non-final JIT instruction fallthrough target 0x${instruction.nextEip.toString(16)} ` +
        `does not match next instruction EIP 0x${nextInstruction.eip.toString(16)}`
      );
    }
  }
}

function isFallthroughTerminator(op: IrOp): op is Extract<IrOp, { op: "next" }> {
  return op.op === "next";
}

function validateJitInstructionOp(op: IrOp): void {
  visitIrOpStorageRefs(op, (storage) => validateBoundStorage(storage));
  visitIrOpValueRefs(op, (value) => validateBoundValue(value));

  if (op.op === "address") {
    throw new Error("JIT IR must not contain source-local address operands");
  }
}

function validateBoundStorage(storage: StorageRef): void {
  if (storage.kind === "operand") {
    throw new Error("JIT IR must not contain source-local operand storage");
  }
}

function validateBoundValue(value: ValueRef): void {
  if (value.kind === "nextEip") {
    throw new Error("JIT IR must not contain nextEip refs");
  }
}

function varDefinitionLabel(definition: VarDefinition): string {
  return `${definition.instructionIndex}:${definition.opIndex}`;
}
