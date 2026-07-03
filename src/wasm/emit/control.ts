import { assert } from "#common/assert.js";
import type { DispatchFinish, ExitFinish, HostExitReason } from "#ir/actions.js";
import type { ValueId } from "#ir/values.js";
import { CpuExceptionVector, type CpuException } from "#x86/exceptions.js";
import { u32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  CompletionExit,
  HostExit,
  encodeCompletionExit,
  encodeCpuExceptionExitBase,
  encodeHostExit
} from "#wasm/exit.js";
import type { DispatchTarget, FallthroughTarget, LinkCompletion } from "./embed.js";

// Report and completion lowering for nested bodies emitted inline by emit.ts.

export type ControlFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  dispatch: DispatchTarget | undefined;
  fallthrough: FallthroughTarget | undefined;
  // Pushes an exit payload value.
  emitPayload(id: ValueId): void;
  constValue(id: ValueId): number | undefined;
}>;

export type ControlFrame = Readonly<{
  emitReport(exit: ExitFinish): void;
  // Applies the embedding's dispatch target for dispatch.targetEip.
  emitDispatch(dispatch: DispatchFinish): void;
  // Applies the embedding to a natural action-body fallthrough.
  emitFallthrough(): void;
  // Runs emitBody while completions account for one enclosing Wasm control
  // construct, so `br` completions can escape inline if bodies.
  withNestedControl(emitBody: () => void): void;
}>;

type LinkedTarget = Readonly<
  | { kind: "dynamic" }
  | { kind: "function"; functionIndex: number }
  | { kind: "table"; slot: number; typeIndex: number; tableIndex: number }
>;

// One frame per emission. Nested bodies are emitted at their action site,
// while this helper owns report and completion lowering. A `br` completion
// inside an inline if must skip that if before it can target the embedder's
// label.
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
        body.i64Const(encodeCompletionExit(CompletionExit.DYNAMIC_JUMP, 0)).returnFromFunction();
        return;
      case "function":
        body.returnCallFunction(target.functionIndex);
        return;
      case "table":
        body.i32Const(target.slot).returnCallIndirect(target.typeIndex, target.tableIndex);
        return;
    }
  }

  function emitReport(exit: ExitFinish): void {
    switch (exit.exit.class) {
      case "host":
        emitHostReport(exit.exit.reason, exit.exit.payload);
        return;
      case "cpuException":
        emitCpuExceptionReport(exit.exit.exception);
        return;
    }
  }

  function emitHostReport(reason: HostExitReason, payload: ValueId | undefined): void {
    const code = hostExitReasonCode(reason);

    if (payload === undefined) {
      body.i64Const(encodeHostExit(code, 0)).returnFromFunction();
      return;
    }

    context.emitPayload(payload);
    body.i64ExtendI32U().i64Const(encodeHostExit(code, 0)).i64Or().returnFromFunction();
  }

  function emitCpuExceptionReport(exception: CpuException<ValueId>): void {
    switch (exception.kind) {
      case "PF":
        context.emitPayload(exception.linearAddress);
        body
          .i64ExtendI32U()
          .i64Const(encodeCpuExceptionExitBase(CpuExceptionVector.PF, exception.errorCode))
          .i64Or()
          .returnFromFunction();
        return;
    }
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

// ir/action names host exit reasons; the emitter owns the numeric encoding.
function hostExitReasonCode(reason: HostExitReason): HostExit {
  switch (reason) {
    case "hostTrap":
      return HostExit.TRAP;
    case "unsupported":
      return HostExit.UNSUPPORTED;
  }
}
