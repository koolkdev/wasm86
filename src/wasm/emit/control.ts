import { assert } from "#common/assert.js";
import type { ActionExitReason, DispatchFinish, ExitFinish } from "#ir/actions.js";
import type { ValueId } from "#ir/values.js";
import { u32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import type { DispatchTarget, FallthroughTarget, LinkCompletion } from "./embed.js";

// Report and completion lowering for edge bodies emitted inline by emit.ts.

export type ControlFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  dispatch: DispatchTarget | undefined;
  fallthrough: FallthroughTarget | undefined;
  // Pushes an exit payload value.
  emitPayload(id: ValueId): void;
  constValue(id: ValueId): number | undefined;
}>;

export type ControlFrame = Readonly<{
  // Detail is the guard's byte length on fault edges.
  emitReport(exit: ExitFinish, detail?: number): void;
  // Applies the embedding's dispatch target for dispatch.targetEip.
  emitDispatch(dispatch: DispatchFinish): void;
  // Applies the embedding to a natural action-body fallthrough.
  emitFallthrough(): void;
  // Runs emitBody while completions account for one enclosing Wasm control
  // construct, so `br` completions can escape inline guard or branch bodies.
  withNestedControl(emitBody: () => void): void;
}>;

type LinkedTarget = Readonly<
  | { kind: "dynamic" }
  | { kind: "function"; functionIndex: number }
  | { kind: "table"; slot: number; typeIndex: number; tableIndex: number }
>;

// One frame per emission. Edge bodies are emitted at their action site
// (guard if body, branch if/else arms), while this helper owns report and
// completion lowering. A `br` completion inside an inline if must skip that
// if before it can target the embedder's label.
export function createControlFrame(context: ControlFrameContext): ControlFrame {
  const { body } = context;
  let inlineControlDepth = 0;

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

  function emitDispatch(dispatch: DispatchFinish): void {
    const target = context.dispatch;

    assert(target !== undefined, "dispatch action requires embedding.dispatch");

    switch (target.kind) {
      case "br":
        body.br(target.depth + inlineControlDepth);
        return;
      case "link":
        emitLinkedCompletion(resolveLinkedTarget(target, dispatch.targetEip));
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

  // State, including EIP, is already flushed by ordinary actions, so a
  // constant target is a bare tail call.
  function emitLinkedCompletion(target: LinkedTarget): void {
    switch (target.kind) {
      case "dynamic":
        body.i64Const(encodeExit(ExitReason.DYNAMIC_JUMP, 0)).returnFromFunction();
        return;
      case "function":
        body.returnCallFunction(target.functionIndex);
        return;
      case "table":
        body.i32Const(target.slot).returnCallIndirect(target.typeIndex, target.tableIndex);
        return;
    }
  }

  function emitReport(exit: ExitFinish, detail = 0): void {
    const reason = exitReasonCode(exit.reason);

    if (exit.payload === undefined) {
      body.i64Const(encodeExit(reason, 0, detail)).returnFromFunction();
      return;
    }

    context.emitPayload(exit.payload);
    body.i64ExtendI32U().i64Const(encodeExit(reason, 0, detail)).i64Or().returnFromFunction();
  }

  return {
    emitReport,
    emitDispatch,
    emitFallthrough,
    withNestedControl(emitBody: () => void): void {
      inlineControlDepth += 1;
      try {
        emitBody();
      } finally {
        inlineControlDepth -= 1;
      }
    }
  };
}

// ir/action names exit reasons; the emitter owns the numeric encoding.
function exitReasonCode(reason: ActionExitReason): ExitReason {
  switch (reason) {
    case "hostTrap":
      return ExitReason.HOST_TRAP;
    case "unsupported":
      return ExitReason.UNSUPPORTED;
    case "decodeFault":
      return ExitReason.DECODE_FAULT;
    case "memoryReadFault":
      return ExitReason.MEMORY_READ_FAULT;
    case "memoryWriteFault":
      return ExitReason.MEMORY_WRITE_FAULT;
  }
}
