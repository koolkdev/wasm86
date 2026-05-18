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
import type { Effect } from "#backends/wasm/jit/codegen/plan/effect-types.js";
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

export type ControlEffect = Extract<
  Effect,
  { kind: "jump" | "branch" | "hostTrap" | "fallthrough" }
>;

export type ControlEffectsEmitter = Readonly<{
  emit(effect: ControlEffect, values: ValueEmitter): void;
}>;

export type ControlEffectsEmitterContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  frame: ExitFrame;
  linking?: JitLinkEmitContext | undefined;
}>;

export function createControlEffectsEmitter(
  context: ControlEffectsEmitterContext
): ControlEffectsEmitter {
  const {
    body,
    scratch,
    frame,
    linking
  } = context;

  return {
    emit: (effect, values) => emitControlEffect(effect, values)
  };

  function emitControlEffect(effect: ControlEffect, values: ValueEmitter): void {
    switch (effect.kind) {
      case "jump":
        emitControlTransfer(
          values,
          effect.target,
          effect.exit
        );
        return;
      case "branch":
        emitBranchEffect(effect, values);
        return;
      case "hostTrap":
        emitHostTrapEffect(effect, values);
        return;
      case "fallthrough":
        emitFallthroughEffect(effect, values);
        return;
    }
  }

  function emitBranchEffect(
    effect: Extract<ControlEffect, { kind: "branch" }>,
    values: ValueEmitter
  ): void {
    values.emit(effect.condition, { requestedWidth: 32 });
    body.ifBlock();
    emitControlTransfer(values, effect.takenTarget, effect.taken, 1);
    body.elseBlock();
    emitControlTransfer(values, effect.notTakenTarget, effect.notTaken, 1);
    body.endBlock();
  }

  function emitHostTrapEffect(
    effect: Extract<ControlEffect, { kind: "hostTrap" }>,
    values: ValueEmitter
  ): void {
    values.withPath(effect.exit.path, () => {
      assertRuntimePayload(effect.exit, "hostTrapVector");

      const vectorLocal = scratch.allocLocal(wasmValueType.i32);

      try {
        values.emit(effect.vector, { requestedWidth: 32 });
        body.localSet(vectorLocal);
        const destination = frame.captureDestination(values, effect.exit);

        body.localGet(vectorLocal);
        frame.emitMetadata(effect.exit);
        emitWasmIrExitFromI32Stack(body, {
          destination,
          reason: effect.exit.reason
        });
      } finally {
        scratch.freeLocal(vectorLocal);
      }
    });
  }

  function emitFallthroughEffect(
    effect: Extract<ControlEffect, { kind: "fallthrough" }>,
    values: ValueEmitter
  ): void {
    values.withPath(effect.exit.path, () => {
      if (effect.exit.payload.kind !== "static") {
        throw new Error(`JIT ${effect.exit.kind} exit requires a static payload`);
      }

      const targetEip = u32(effect.exit.payload.value);

      if (emitLinkedStaticControlTransfer(values, targetEip, effect.exit)) {
        return;
      }

      const destination = frame.captureDestination(values, effect.exit);

      frame.emitMetadata(effect.exit);
      emitWasmIrExitConstPayload(body, {
        destination,
        reason: effect.exit.reason,
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
