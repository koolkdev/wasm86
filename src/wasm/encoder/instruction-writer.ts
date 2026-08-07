import type { ByteSink } from "./byte-sink.js";
import type { WasmBranchHint, WasmInstructionDescriptor } from "./instructions.js";

type EncodedBranchHint = Readonly<{
  offset: number;
  value: 0 | 1;
}>;

export type WasmInstructionWriter = Readonly<{
  write: <Args extends readonly unknown[]>(
    instruction: WasmInstructionDescriptor<Args>,
    ...args: Args
  ) => void;
}>;

export function createWasmInstructionWriter(body: ByteSink): Readonly<{
  writer: WasmInstructionWriter;
  branchHints: readonly EncodedBranchHint[];
}> {
  const branchHints: EncodedBranchHint[] = [];
  const writer: WasmInstructionWriter = {
    write<Args extends readonly unknown[]>(
      instruction: WasmInstructionDescriptor<Args>,
      ...args: Args
    ): void {
      const instructionOffset = body.byteLength;

      body.writeByte(instruction.opcode);
      instruction.encodeImmediate(body, ...args);

      const branchHint = instruction.branchHint?.(...args);
      if (branchHint !== undefined) {
        branchHints.push({
          offset: instructionOffset,
          value: encodeBranchHint(branchHint)
        });
      }
    }
  };

  return { writer, branchHints };
}

function encodeBranchHint(hint: WasmBranchHint): 0 | 1 {
  switch (hint) {
    case "unlikely":
      return 0;
    case "likely":
      return 1;
  }
}
