import { assert } from "#common/assert.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";

// Tracks structured labels while one symbolic function is emitted.

export type FunctionFrameContext = Readonly<{
  body: WasmInstructionWriter;
}>;

export type FunctionFrame = Readonly<{
  withNestedControl(emitBody: () => void, labels?: number): void;
  withLoopBody(emitBody: () => void): void;
  emitLoopContinue(): void;
}>;

export function createFunctionFrame(
  context: FunctionFrameContext
): FunctionFrame {
  const { body } = context;
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
      body.br(inlineControlDepth - mark);
    }
  };
}

export function emitCall(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  target: CallTarget
): void {
  switch (target.kind) {
    case "direct":
      body.callFunction(bindings.functionIndex(target.ref));
      return;
    case "indirect":
      body.callIndirect(
        bindings.typeIndex(target.type),
        bindings.tableIndex(target.table)
      );
      return;
  }
}

export function emitReturnCall(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  target: CallTarget
): void {
  switch (target.kind) {
    case "direct":
      body.returnCallFunction(bindings.functionIndex(target.ref));
      return;
    case "indirect":
      body.returnCallIndirect(
        bindings.typeIndex(target.type),
        bindings.tableIndex(target.table)
      );
      return;
  }
}
