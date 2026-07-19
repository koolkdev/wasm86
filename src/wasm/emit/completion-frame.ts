import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { u32 } from "#core/numeric.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeTransfer } from "#engines/jit/legacy-transfer.js";
import type { DispatchTarget, FallthroughTarget, LinkCompletion } from "./embed.js";

// Exit and completion lowering for nested bodies emitted inline by the action
// emitter.

export type CompletionFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  dispatch: DispatchTarget | undefined;
  fallthrough: FallthroughTarget | undefined;
  emitValue(id: ValueId): void;
  constValue(id: ValueId): number | undefined;
}>;

export type CompletionFrame = Readonly<{
  emitExit(result: ValueId): void;
  // Applies the embedding's dispatch target for targetEip.
  emitDispatch(targetEip: ValueId): void;
  // Applies the embedding to a natural action-body fallthrough.
  emitFallthrough(): void;
  // Runs emitBody while completions account for `labels` enclosing Wasm
  // control constructs, so `br` completions can escape inline bodies.
  withNestedControl(emitBody: () => void, labels?: number): void;
  // Runs emitBody as the body of a just-opened Wasm loop block, so
  // emitLoopContinue can branch back to the innermost loop label.
  withLoopBody(emitBody: () => void): void;
  emitLoopContinue(): void;
}>;

type LinkedTarget = Readonly<
  | { kind: "dynamic" }
  | { kind: "function"; functionIndex: number }
  | { kind: "table"; slot: number; typeIndex: number; tableIndex: number }
>;

// One frame per emission. Nested bodies are emitted at their action site,
// while this helper owns exit and completion lowering. A `br` completion
// inside an inline if must skip that if before it can target the embedder's
// label.
export function createCompletionFrame(
  context: CompletionFrameContext
): CompletionFrame {
  const { body } = context;
  let inlineControlDepth = 0;
  // Each mark is the inline depth just inside its loop block.
  const loopMarks: number[] = [];

  function emitFallthrough(): void {
    const target = context.fallthrough;

    assert(target !== undefined, "action body has no fallthrough target");

    switch (target.kind) {
      case "fallthrough":
        return;
      case "br":
        body.br(target.depth + inlineControlDepth);
        return;
    }
  }

  function emitDispatch(targetEip: ValueId): void {
    const target = context.dispatch;

    assert(target !== undefined, "dispatch control requires embedding.dispatch");

    switch (target.kind) {
      case "br":
        body.br(target.depth + inlineControlDepth);
        return;
      case "link":
        emitLinkedCompletion(resolveLinkedTarget(target, targetEip));
        return;
    }
  }

  function resolveLinkedTarget(link: LinkCompletion, eip: ValueId): LinkedTarget {
    const target = context.constValue(eip);

    if (target === undefined) {
      return { kind: "dynamic" };
    }

    const functionIndex = link.functionFor(target);

    if (functionIndex !== undefined) {
      return { kind: "function", functionIndex };
    }

    const slot = link.table?.slotFor(target);

    assert(
      link.table !== undefined && slot !== undefined,
      `constant link target 0x${u32(target).toString(16)} has no function or table slot`
    );
    return { kind: "table", slot, typeIndex: link.table.typeIndex, tableIndex: link.table.tableIndex };
  }

  function emitLinkedCompletion(target: LinkedTarget): void {
    switch (target.kind) {
      case "dynamic":
        body.i64Const(
          encodeTransfer({ kind: "dynamicJump" })
        ).returnFromFunction();
        return;
      case "function":
        body.returnCallFunction(target.functionIndex);
        return;
      case "table":
        body.i32Const(target.slot).returnCallIndirect(target.typeIndex, target.tableIndex);
        return;
    }
  }

  function emitExit(result: ValueId): void {
    context.emitValue(result);
    body.returnFromFunction();
  }

  return {
    emitExit,
    emitDispatch,
    emitFallthrough,
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
