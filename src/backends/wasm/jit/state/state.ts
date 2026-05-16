import { i32 } from "#x86/state/cpu-state.js";
import { stateOffset } from "#backends/wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitLoadStateU32, emitStoreStateU32 } from "#backends/wasm/codegen/state.js";
import type {
  ExitStoreSet,
  PlannedExit
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import {
  captureExitStores,
  emitExitStores,
  releaseExitStores,
  type CapturedExitStore
} from "#backends/wasm/jit/codegen/emit/exit-stores.js";

export type JitExitTarget = {
  exitLocal: number;
  exitLabelDepth: number;
  emitBeforeExit?: () => void;
};

type JitStateOptions = Readonly<{
  valueCache?: JitValueCacheRuntime | undefined;
}>;

type JitCapturedExitStoreSet = readonly CapturedExitStore[];

export type JitState = Readonly<{
  eipLocal: number;
  instructionCountLocal: number;
  maxExitStoreIndex: number;
  emitLoadInstructionCount(): void;
  beginInstruction(exit: JitExitTarget, instructionCountDelta: number, entryEip: number): void;
  prepareExitPoint(exit: PlannedExit, emitRuntimeVisibleEip?: () => void): void;
  commitInstructionExit(exit: PlannedExit, emitRuntimeVisibleEip?: () => void): void;
  emitExitStores(index: number): void;
  releaseExitStores(index: number): void;
}>;

export function createJitState(
  body: WasmFunctionBodyEncoder,
  exitStoreSets: readonly ExitStoreSet[],
  options: JitStateOptions = {}
): JitState {
  const maxExitStoreIndex = exitStoreSets.length - 1;
  const eipLocal = body.addLocal(wasmValueType.i32);
  const instructionCountLocal = body.addLocal(wasmValueType.i32);
  const capturedExitStoreSets = new Map<number, JitCapturedExitStoreSet>();
  let activeExit: JitExitTarget | undefined;

  return {
    eipLocal,
    instructionCountLocal,
    maxExitStoreIndex,
    emitLoadInstructionCount: () => {
      emitLoadStateU32(body, stateOffset.instructionCount);
      body.localSet(instructionCountLocal);
    },
    beginInstruction: (exit, instructionCountDelta, entryEip) => {
      activeExit = exit;
      useExitStoreSet(exit, 0);
      installExitMetadataStores(exit, () => {
        body.i32Const(i32(entryEip));
      }, instructionCountDelta);
    },
    prepareExitPoint: (plannedExit, emitRuntimeVisibleEip) => {
      const exit = requiredActiveExit();

      captureExitStoreSet(plannedExit.exitStoreIndex);

      useExitStoreSet(exit, plannedExit.exitStoreIndex);
      installExitMetadataStores(
        exit,
        () => emitExitVisibleEip(plannedExit, emitRuntimeVisibleEip),
        plannedExit.snapshot.instructionCountDelta
      );
    },
    commitInstructionExit: (plannedExit, emitRuntimeVisibleEip) => {
      const exit = requiredActiveExit();

      emitExitVisibleEip(plannedExit, emitRuntimeVisibleEip);
      body.localSet(eipLocal);
      captureExitStoreSet(plannedExit.exitStoreIndex);
      useExitStoreSet(exit, plannedExit.exitStoreIndex);
      installExitMetadataStores(exit, () => {
        body.localGet(eipLocal);
      }, plannedExit.snapshot.instructionCountDelta);
    },
    emitExitStores: (index) => {
      const plan = exitStoreSets[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit store set: ${index}`);
      }

      const capturedStores = capturedExitStoreSets.get(index);

      if (plan.stores.length !== 0) {
        if (capturedStores === undefined) {
          throw new Error(`JIT exit store set was not captured: ${index}`);
        }

        emitExitStores({
          body,
          valueCache: options.valueCache
        }, capturedStores);
      }
    },
    releaseExitStores: (index) => {
      const plan = exitStoreSets[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit store set: ${index}`);
      }

      if (plan.stores.length === 0) {
        return;
      }

      const capturedStores = capturedExitStoreSets.get(index);

      if (capturedStores === undefined) {
        throw new Error(`JIT exit store set was not captured: ${index}`);
      }

      releaseExitStores(capturedStores);

      capturedExitStoreSets.delete(index);
    }
  };

  function installExitMetadataStores(
    exit: JitExitTarget,
    emitEip: () => void,
    instructionDelta: number
  ): void {
    exit.emitBeforeExit = () => {
      emitStoreStateU32(body, stateOffset.eip, emitEip);
      emitStoreStateU32(body, stateOffset.instructionCount, () => {
        body.localGet(instructionCountLocal);

        if (instructionDelta !== 0) {
          body.i32Const(instructionDelta).i32Add();
        }
      });
    };
  }

  function useExitStoreSet(exit: JitExitTarget, index: number): void {
    exit.exitLabelDepth = maxExitStoreIndex - index;
  }

  function captureExitStoreSet(index: number): void {
    if (capturedExitStoreSets.has(index)) {
      return;
    }

    const capturedStores = captureExitStoresForIndex(index);

    storeCapturedExitStores(index, capturedStores);
  }

  function captureExitStoresForIndex(index: number): JitCapturedExitStoreSet | undefined {
    const plan = exitStoreSets[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit store set: ${index}`);
    }

    const capturedStores = captureExitStores({
      body,
      valueCache: options.valueCache
    }, plan.stores);

    return capturedStores;
  }

  function storeCapturedExitStores(
    index: number,
    capturedStores: JitCapturedExitStoreSet | undefined
  ): void {
    const plan = exitStoreSets[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit store set: ${index}`);
    }

    if (plan.stores.length === 0) {
      return;
    }

    if (capturedStores === undefined) {
      throw new Error(`JIT exit store set was not captured: ${index}`);
    }

    capturedExitStoreSets.set(index, capturedStores);
  }

  function requiredActiveExit(): JitExitTarget {
    if (activeExit === undefined) {
      throw new Error("JIT instruction exit requested before beginInstruction");
    }

    return activeExit;
  }

  function emitExitVisibleEip(
    exit: PlannedExit,
    emitRuntimeVisibleEip: (() => void) | undefined
  ): void {
    switch (exit.visibleEip.kind) {
      case "static":
        body.i32Const(i32(exit.visibleEip.value));
        return;
      case "runtime":
        if (emitRuntimeVisibleEip === undefined) {
          throw new Error("JIT runtime visible EIP requested without an emitter");
        }

        emitRuntimeVisibleEip();
        return;
    }
  }
}
