import type { IrBlock } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "./operand-bindings.js";

export type InstructionMetadata = Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
}>;

export type JitInstruction = InstructionMetadata & Readonly<{
  operands: readonly JitOperandBinding[];
  ir: IrBlock;
}>;

export type JitBlock = Readonly<{
  instructions: readonly JitInstruction[];
}>;
