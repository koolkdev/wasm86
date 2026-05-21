import type { IrBlock } from "#x86/ir/model/types.js";

export type InstructionMetadata = Readonly<{
  instructionId: string;
  eip: number;
}>;

export type JitIrInstruction = InstructionMetadata & Readonly<{
  nextEip: number;
  ir: IrBlock;
}>;

export type JitIrBlock = Readonly<{
  instructions: readonly JitIrInstruction[];
}>;
