import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";

export type RecordedInstruction = Readonly<{
  instruction: object;
  arguments: readonly unknown[];
}>;

export function recordInstructions(): Readonly<{
  writer: WasmInstructionWriter;
  instructions: readonly RecordedInstruction[];
}> {
  const instructions: RecordedInstruction[] = [];
  const writer: WasmInstructionWriter = {
    write(instruction, ...args): void {
      instructions.push({ instruction, arguments: args });
    }
  };

  return { writer, instructions };
}
