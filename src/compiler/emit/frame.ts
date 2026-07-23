import { assert } from "#common/assert.js";
import { wasmInstruction } from "#compiler/encoder/instructions.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";

// Tracks structured labels while one symbolic function is emitted.

type FunctionFrame = Readonly<{
  withNestedControl(emitBody: () => void, labels?: number): void;
  withLoopBody(emitBody: () => void): void;
  emitLoopContinue(): void;
}>;

export function createFunctionFrame({
  body
}: Readonly<{
  body: WasmInstructionWriter;
}>): FunctionFrame {
  let inlineControlDepth = 0;
  // Each mark is the inline depth just inside its loop block.
  const loopMarks: number[] = [];

  return {
    withNestedControl(emitBody: () => void, labels = 1): void {
      inlineControlDepth += labels;
      try {
        emitBody();
      } finally {
        inlineControlDepth -= labels;
      }
    },
    withLoopBody(emitBody: () => void): void {
      inlineControlDepth += 1;
      loopMarks.push(inlineControlDepth);
      try {
        emitBody();
      } finally {
        loopMarks.pop();
        inlineControlDepth -= 1;
      }
    },
    emitLoopContinue(): void {
      const mark = loopMarks[loopMarks.length - 1];

      assert(mark !== undefined, "continue emitted outside a loop body");
      body.write(wasmInstruction.control.br, inlineControlDepth - mark);
    }
  };
}
