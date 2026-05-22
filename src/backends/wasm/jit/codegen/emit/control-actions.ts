import { u32 } from "#x86/state/cpu-state.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import {
  emitWasmIrExitConstPayload,
  emitWasmIrExitFromI32Stack
} from "#backends/wasm/codegen/exit.js";
import type { JitModuleLinkTable } from "#backends/wasm/jit/compiled-blocks/module-link-table.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type { RuntimeEntry } from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ValueEmitter } from "./values.js";
import type { ExitFrame } from "./exit-frame.js";

export type JitLinkResolver = Readonly<{
  moduleTable?: JitModuleLinkTable;
  functionIndexForStaticTarget?: (eip: number) => number | undefined;
  slotForStaticTarget?: (eip: number) => number;
}>;

export type JitLinkEmitContext = JitLinkResolver & Readonly<{
  blockTypeIndex: number;
  tableIndex?: number;
}>;

export type ControlAction = Extract<
  RuntimeEntry,
  { kind: "jump" | "branch" | "hostTrap" | "fallthrough" }
>;

export type ControlActionEmitter = Readonly<{
  emit(action: ControlAction, values: ValueEmitter): void;
}>;

export type ControlActionEmitterContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  frame: ExitFrame;
  linking?: JitLinkEmitContext | undefined;
}>;

export function createControlActionEmitter(
  context: ControlActionEmitterContext
): ControlActionEmitter {
  const {
    body,
    scratch,
    frame,
    linking
  } = context;

  return {
    emit: (action, values) => emitControlAction(action, values)
  };

  function emitControlAction(action: ControlAction, values: ValueEmitter): void {
    switch (action.kind) {
      case "jump":
        emitControlTransfer(
          values,
          action.target,
          action.exit
        );
        return;
      case "branch":
        emitBranchAction(action, values);
        return;
      case "hostTrap":
        emitHostTrapAction(action, values);
        return;
      case "fallthrough":
        emitFallthroughAction(action, values);
        return;
    }
  }

  function emitBranchAction(
    action: Extract<ControlAction, { kind: "branch" }>,
    values: ValueEmitter
  ): void {
    values.emit(action.condition, { requestedWidth: 32 });
    body.ifBlock();
    emitControlTransfer(values, action.takenTarget, action.taken, 1);
    body.elseBlock();
    emitControlTransfer(values, action.notTakenTarget, action.notTaken, 1);
    body.endBlock();
  }

  function emitHostTrapAction(
    action: Extract<ControlAction, { kind: "hostTrap" }>,
    values: ValueEmitter
  ): void {
    values.withPath(action.exit.path, () => {
      assertRuntimePayload(action.exit, "hostTrapVector");

      const vectorLocal = scratch.allocLocal(wasmValueType.i32);

      try {
        values.emit(action.vector, { requestedWidth: 32 });
        body.localSet(vectorLocal);
        const destination = frame.captureDestination(values, action.exit);

        body.localGet(vectorLocal);
        frame.emitMetadata(action.exit);
        emitWasmIrExitFromI32Stack(body, {
          destination,
          reason: action.exit.reason
        });
      } finally {
        scratch.freeLocal(vectorLocal);
      }
    });
  }

  function emitFallthroughAction(
    action: Extract<ControlAction, { kind: "fallthrough" }>,
    values: ValueEmitter
  ): void {
    values.withPath(action.exit.path, () => {
      if (action.exit.payload.kind !== "static") {
        throw new Error(`JIT ${action.exit.kind} exit requires a static payload`);
      }

      const targetEip = u32(action.exit.payload.value);

      if (emitLinkedStaticControlTransfer(values, targetEip, action.exit)) {
        return;
      }

      const destination = frame.captureDestination(values, action.exit);

      frame.emitMetadata(action.exit);
      emitWasmIrExitConstPayload(body, {
        destination,
        reason: action.exit.reason,
        payload: targetEip
      });
    });
  }

  function emitControlTransfer(
    transferValues: ValueEmitter,
    target: JitValue,
    exit: Exit,
    extraDepth = 0
  ): void {
    transferValues.withPath(exit.path, () => {
      switch (exit.payload.kind) {
        case "runtime":
          emitDynamicControlTransfer(transferValues, target, exit, extraDepth);
          return;
        case "static":
          emitStaticControlTransfer(transferValues, u32(exit.payload.value), exit, extraDepth);
          return;
      }
    });
  }

  function emitDynamicControlTransfer(
    transferValues: ValueEmitter,
    target: JitValue,
    exit: Exit,
    extraDepth: number
  ): void {
    assertRuntimePayload(exit, "controlTarget");

    const targetLocal = scratch.allocLocal(wasmValueType.i32);

    try {
      transferValues.emit(target, { requestedWidth: 32 });
      body.localSet(targetLocal);
      const destination = frame.captureDestination(transferValues, exit);

      body.localGet(targetLocal);
      frame.emitMetadata(exit, {
        emitRuntimeVisibleEip: () => {
          body.localGet(targetLocal);
        }
      });
      emitWasmIrExitFromI32Stack(body, {
        destination,
        reason: exit.reason,
        extraDepth
      });
    } finally {
      scratch.freeLocal(targetLocal);
    }
  }

  function emitStaticControlTransfer(
    values: ValueEmitter,
    targetEip: number,
    exit: Exit,
    extraDepth: number
  ): void {
    if (emitLinkedStaticControlTransfer(values, targetEip, exit)) {
      return;
    }

    const destination = frame.captureDestination(values, exit);

    frame.emitMetadata(exit);
    emitWasmIrExitConstPayload(body, {
      destination,
      reason: exit.reason,
      payload: targetEip,
      extraDepth
    });
  }

  function emitLinkedStaticControlTransfer(
    values: ValueEmitter,
    targetEip: number,
    exit: Exit
  ): boolean {
    if (linking === undefined) {
      return false;
    }

    const directFunctionIndex = linking.functionIndexForStaticTarget?.(targetEip);

    if (directFunctionIndex !== undefined) {
      frame.emitLinkedStores(values, exit);
      body.returnCallFunction(directFunctionIndex);
      return true;
    }

    if (linking.tableIndex !== undefined && linking.slotForStaticTarget !== undefined) {
      frame.emitLinkedStores(values, exit);
      body
        .i32Const(linking.slotForStaticTarget(targetEip))
        .returnCallIndirect(linking.blockTypeIndex, linking.tableIndex);
      return true;
    }

    return false;
  }
}

function assertRuntimePayload(
  exit: Exit,
  source: Exclude<Exit["payload"], { kind: "static" }>["source"]
): void {
  if (exit.payload.kind !== "runtime" || exit.payload.source !== source) {
    throw new Error(`JIT ${exit.kind} exit requires runtime ${source} payload`);
  }
}
