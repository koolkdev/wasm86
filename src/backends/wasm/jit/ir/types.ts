import type { IrBlock } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "./operand-bindings.js";

export type InstructionMetadata = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  operands: readonly JitOperandBinding[];
}>;

export type JitIrInstruction = InstructionMetadata & Readonly<{
  ir: IrBlock;
}>;

export type JitIrBlock = Readonly<{
  instructions: readonly JitIrInstruction[];
}>;
