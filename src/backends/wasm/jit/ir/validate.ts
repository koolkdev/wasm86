import { validateIrBlock } from "#x86/ir/passes/validator.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeJitBarriers,
  type JitBarrier,
  type JitBarrierAnalysis
} from "#backends/wasm/jit/ir/barriers.js";

export type JitIrValidationOptions = Readonly<{
  barriers?: JitBarrierAnalysis;
}>;

export function validateJitIrBlock(
  block: JitIrBlock,
  options: JitIrValidationOptions = {}
): void {
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

  const barriers = options.barriers ?? analyzeJitBarriers(block);

  validateJitBarrierIndex(block, barriers);
}

function validateJitInstructionBody(
  instruction: JitIrBlockInstruction
): void {
  validateIrBlock(instruction.ir, {
    operandCount: instruction.operands.length,
    terminatorMode: "single"
  });
}

function validateJitBarrierIndex(block: JitIrBlock, barriers: JitBarrierAnalysis): void {
  if (barriers.instructions.length !== block.instructions.length) {
    throw new Error(`JIT barrier instruction count mismatch: ${barriers.instructions.length} !== ${block.instructions.length}`);
  }

  const flatBarriers = new Set(barriers.barriers);

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];
    const instructionBarriers = barriers.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`barrier index references missing instruction ${instructionIndex}`);
    }

    if (instructionBarriers === undefined) {
      throw new Error(`missing JIT barrier instruction: ${instructionIndex}`);
    }

    if (instructionBarriers.ops.length !== instruction.ir.length) {
      throw new Error(
        `JIT barrier op count mismatch at instruction ${instructionIndex}: ` +
        `${instructionBarriers.ops.length} !== ${instruction.ir.length}`
      );
    }

    for (const barrier of instructionBarriers.barriers) {
      validateIndexedBarrier(block, flatBarriers, barrier, instructionIndex);
    }

    for (let opIndex = 0; opIndex < instructionBarriers.ops.length; opIndex += 1) {
      for (const barrier of instructionBarriers.ops[opIndex] ?? []) {
        if (barrier.opIndex !== opIndex) {
          throw new Error(`barrier is indexed under the wrong op at ${instructionIndex}:${opIndex}`);
        }

        validateIndexedBarrier(block, flatBarriers, barrier, instructionIndex);
      }
    }
  }

  for (const barrier of barriers.barriers) {
    validateBarrierLocation(block, barrier);
    validateBarrierShape(barrier);
    validateFlatBarrierIsIndexed(barriers, barrier);
  }
}

function validateFlatBarrierIsIndexed(barriers: JitBarrierAnalysis, barrier: JitBarrier): void {
  if (barrier.opIndex === undefined) {
    throw new Error(`barrier is missing op location at instruction ${barrier.instructionIndex}`);
  }

  const instructionBarriers = barriers.instructions[barrier.instructionIndex];

  if (instructionBarriers === undefined || !instructionBarriers.barriers.includes(barrier)) {
    throw new Error(`flat barrier is missing from its instruction index at ${barrier.instructionIndex}`);
  }

  if (!instructionBarriers.ops[barrier.opIndex]?.includes(barrier)) {
    throw new Error(`flat barrier is missing from its op index at ${barrier.instructionIndex}:${barrier.opIndex}`);
  }
}

function validateIndexedBarrier(
  block: JitIrBlock,
  flatBarriers: ReadonlySet<JitBarrier>,
  barrier: JitBarrier,
  instructionIndex: number
): void {
  if (barrier.instructionIndex !== instructionIndex) {
    throw new Error(`barrier is indexed under the wrong instruction at ${instructionIndex}`);
  }

  if (!flatBarriers.has(barrier)) {
    throw new Error(`barrier index contains a barrier missing from the flat barrier list at ${instructionIndex}`);
  }

  validateBarrierLocation(block, barrier);
  validateBarrierShape(barrier);
}

function validateBarrierLocation(block: JitIrBlock, barrier: JitBarrier): void {
  const instruction = block.instructions[barrier.instructionIndex];

  if (instruction === undefined) {
    throw new Error(`barrier references missing instruction ${barrier.instructionIndex}`);
  }

  if (barrier.opIndex === undefined) {
    throw new Error(`barrier is missing op location at instruction ${barrier.instructionIndex}`);
  }

  if (instruction.ir[barrier.opIndex] === undefined) {
    throw new Error(`barrier references missing op ${barrier.instructionIndex}:${barrier.opIndex}`);
  }
}

function validateBarrierShape(barrier: JitBarrier): void {
  if (barrier.reason === "preInstructionExit" && barrier.exitReason === undefined) {
    throw new Error(
      `pre-instruction exit barrier is missing its exit reason at ${barrier.instructionIndex}:${barrier.opIndex}`
    );
  }

  if (barrier.reason === "exit" && (barrier.exitReasons?.length ?? 0) === 0) {
    throw new Error(`exit barrier is missing exit reasons at ${barrier.instructionIndex}:${barrier.opIndex}`);
  }
}
