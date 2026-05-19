import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrInstruction } from "#backends/wasm/jit/ir/types.js";

export type JitLocation = Readonly<{
  instructionIndex: number;
  opIndex: number;
}>;

export type JitOpVisitor = (
  instruction: JitIrInstruction,
  op: IrOp,
  location: JitLocation
) => void;

export function jitLocation(instructionIndex: number, opIndex: number): JitLocation {
  return { instructionIndex, opIndex };
}

export function jitLocationBefore(a: JitLocation, b: JitLocation): boolean {
  return a.instructionIndex < b.instructionIndex ||
    (a.instructionIndex === b.instructionIndex && a.opIndex < b.opIndex);
}

export function walkJitBlockOps(
  block: JitIrBlock,
  visit: JitOpVisitor,
  context = "walking JIT IR block"
): void {
  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = requiredJitInstruction(block, instructionIndex, context);

    walkJitInstructionOps(instruction, instructionIndex, visit, context);
  }
}

export function walkJitInstructionOps(
  instruction: JitIrInstruction,
  instructionIndex: number,
  visit: JitOpVisitor,
  context = "walking JIT IR instruction"
): void {
  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while ${context}: ${instructionIndex}:${opIndex}`);
    }

    visit(instruction, op, jitLocation(instructionIndex, opIndex));
  }
}

export function walkJitOpsBetween(
  block: JitIrBlock,
  after: JitLocation,
  before: JitLocation,
  visit: JitOpVisitor
): void {
  if (!jitLocationBefore(after, before)) {
    return;
  }

  for (let instructionIndex = after.instructionIndex; instructionIndex <= before.instructionIndex; instructionIndex += 1) {
    const instruction = requiredJitInstruction(block, instructionIndex, "iterating JIT IR range");
    const startOpIndex = instructionIndex === after.instructionIndex ? after.opIndex + 1 : 0;
    const endOpIndex = instructionIndex === before.instructionIndex ? before.opIndex : instruction.ir.length;

    for (let opIndex = startOpIndex; opIndex < endOpIndex; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while iterating JIT IR range: ${instructionIndex}:${opIndex}`);
      }

      visit(instruction, op, jitLocation(instructionIndex, opIndex));
    }
  }
}

export function requiredJitInstruction(
  block: JitIrBlock,
  instructionIndex: number,
  context = "reading JIT IR instruction"
): JitIrInstruction {
  const instruction = block.instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT instruction while ${context}: ${instructionIndex}`);
  }

  return instruction;
}
