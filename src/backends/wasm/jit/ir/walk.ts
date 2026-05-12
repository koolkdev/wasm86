import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export type JitIrLocation = Readonly<{
  instructionIndex: number;
  opIndex: number;
}>;

export type JitIrOpVisitor = (
  instruction: JitIrBlockInstruction,
  op: IrOp,
  location: JitIrLocation
) => void;

export function jitIrLocation(instructionIndex: number, opIndex: number): JitIrLocation {
  return { instructionIndex, opIndex };
}

export function jitIrLocationBefore(a: JitIrLocation, b: JitIrLocation): boolean {
  return a.instructionIndex < b.instructionIndex ||
    (a.instructionIndex === b.instructionIndex && a.opIndex < b.opIndex);
}

export function walkJitIrBlockOps(
  block: JitIrBlock,
  visit: JitIrOpVisitor,
  context = "walking JIT IR block"
): void {
  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = requiredJitIrInstruction(block, instructionIndex, context);

    walkJitIrInstructionOps(instruction, instructionIndex, visit, context);
  }
}

export function walkJitIrInstructionOps(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  visit: JitIrOpVisitor,
  context = "walking JIT IR instruction"
): void {
  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while ${context}: ${instructionIndex}:${opIndex}`);
    }

    visit(instruction, op, jitIrLocation(instructionIndex, opIndex));
  }
}

export function walkJitIrOpsBetween(
  block: JitIrBlock,
  after: JitIrLocation,
  before: JitIrLocation,
  visit: JitIrOpVisitor
): void {
  if (!jitIrLocationBefore(after, before)) {
    return;
  }

  for (let instructionIndex = after.instructionIndex; instructionIndex <= before.instructionIndex; instructionIndex += 1) {
    const instruction = requiredJitIrInstruction(block, instructionIndex, "iterating JIT IR range");
    const startOpIndex = instructionIndex === after.instructionIndex ? after.opIndex + 1 : 0;
    const endOpIndex = instructionIndex === before.instructionIndex ? before.opIndex : instruction.ir.length;

    for (let opIndex = startOpIndex; opIndex < endOpIndex; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while iterating JIT IR range: ${instructionIndex}:${opIndex}`);
      }

      visit(instruction, op, jitIrLocation(instructionIndex, opIndex));
    }
  }
}

export function requiredJitIrInstruction(
  block: JitIrBlock,
  instructionIndex: number,
  context = "reading JIT IR instruction"
): JitIrBlockInstruction {
  const instruction = block.instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT instruction while ${context}: ${instructionIndex}`);
  }

  return instruction;
}
