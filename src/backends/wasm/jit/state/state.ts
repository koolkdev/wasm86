import { i32 } from "#x86/state/cpu-state.js";
import { stateOffset } from "#backends/wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitLoadStateU32, emitStoreStateU32 } from "#backends/wasm/codegen/state.js";
import type {
  JitExitMaterializationPlan,
  JitExitPoint
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import {
  captureJitExitMaterializationStores,
  emitJitExitMaterializationStores,
  releaseJitExitMaterializationStores,
  type JitCapturedExitMaterializationStore
} from "#backends/wasm/jit/codegen/emit/exit-stores.js";

export type JitExitTarget = {
  exitLocal: number;
  exitLabelDepth: number;
  emitBeforeExit?: () => void;
};

type JitIrStateOptions = Readonly<{
  valueCache?: JitValueCacheRuntime | undefined;
}>;

type JitCapturedExitMaterialization = readonly JitCapturedExitMaterializationStore[];

export type JitIrState = Readonly<{
  eipLocal: number;
  instructionCountLocal: number;
  maxExitMaterializationIndex: number;
  emitLoadInstructionCount(): void;
  beginInstruction(exit: JitExitTarget, instructionCountDelta: number, entryEip: number): void;
  prepareExitPoint(exitPoint: JitExitPoint, emitRuntimeVisibleEip?: () => void): void;
  commitInstructionExit(exitPoint: JitExitPoint, emitRuntimeVisibleEip?: () => void): void;
  emitExitMaterializationStores(index: number): void;
  releaseExitMaterialization(index: number): void;
}>;

export function createJitIrState(
  body: WasmFunctionBodyEncoder,
  exitMaterializations: readonly JitExitMaterializationPlan[],
  options: JitIrStateOptions = {}
): JitIrState {
  const maxExitMaterializationIndex = exitMaterializations.length - 1;
  const eipLocal = body.addLocal(wasmValueType.i32);
  const instructionCountLocal = body.addLocal(wasmValueType.i32);
  const capturedExitMaterializations = new Map<number, JitCapturedExitMaterialization>();
  let activeExit: JitExitTarget | undefined;

  return {
    eipLocal,
    instructionCountLocal,
    maxExitMaterializationIndex,
    emitLoadInstructionCount: () => {
      emitLoadStateU32(body, stateOffset.instructionCount);
      body.localSet(instructionCountLocal);
    },
    beginInstruction: (exit, instructionCountDelta, entryEip) => {
      activeExit = exit;
      useExitMaterialization(exit, 0);
      installExitMetadataStores(exit, () => {
        body.i32Const(i32(entryEip));
      }, instructionCountDelta);
    },
    prepareExitPoint: (exitPoint, emitRuntimeVisibleEip) => {
      const exit = requiredActiveExit();

      captureExitMaterialization(exitPoint.exitMaterializationIndex);

      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(
        exit,
        () => emitObservationVisibleEip(exitPoint, emitRuntimeVisibleEip),
        exitPoint.observedState.instructionCountDelta
      );
    },
    commitInstructionExit: (exitPoint, emitRuntimeVisibleEip) => {
      const exit = requiredActiveExit();

      emitObservationVisibleEip(exitPoint, emitRuntimeVisibleEip);
      body.localSet(eipLocal);
      captureExitMaterialization(exitPoint.exitMaterializationIndex);
      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(exit, () => {
        body.localGet(eipLocal);
      }, exitPoint.observedState.instructionCountDelta);
    },
    emitExitMaterializationStores: (index) => {
      const plan = exitMaterializations[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit materialization: ${index}`);
      }

      const capturedStores = capturedExitMaterializations.get(index);

      if (plan.stores.length !== 0) {
        if (capturedStores === undefined) {
          throw new Error(`JIT exit materialization was not captured: ${index}`);
        }

        emitJitExitMaterializationStores({
          body,
          valueCache: options.valueCache
        }, capturedStores);
      }
    },
    releaseExitMaterialization: (index) => {
      const plan = exitMaterializations[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit materialization: ${index}`);
      }

      if (plan.stores.length === 0) {
        return;
      }

      const capturedStores = capturedExitMaterializations.get(index);

      if (capturedStores === undefined) {
        throw new Error(`JIT exit materialization was not captured: ${index}`);
      }

      releaseJitExitMaterializationStores(capturedStores);

      capturedExitMaterializations.delete(index);
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

  function useExitMaterialization(exit: JitExitTarget, index: number): void {
    exit.exitLabelDepth = maxExitMaterializationIndex - index;
  }

  function captureExitMaterialization(index: number): void {
    if (capturedExitMaterializations.has(index)) {
      return;
    }

    const capturedStores = captureExitMaterializationStoresForIndex(index);

    storeCapturedExitMaterialization(index, capturedStores);
  }

  function captureExitMaterializationStoresForIndex(index: number): JitCapturedExitMaterialization | undefined {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    const capturedStores = captureJitExitMaterializationStores({
      body,
      valueCache: options.valueCache
    }, plan.stores);

    return capturedStores;
  }

  function storeCapturedExitMaterialization(
    index: number,
    capturedStores: JitCapturedExitMaterialization | undefined
  ): void {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    if (plan.stores.length === 0) {
      return;
    }

    if (capturedStores === undefined) {
      throw new Error(`JIT exit materialization was not captured: ${index}`);
    }

    capturedExitMaterializations.set(index, capturedStores);
  }

  function requiredActiveExit(): JitExitTarget {
    if (activeExit === undefined) {
      throw new Error("JIT instruction exit requested before beginInstruction");
    }

    return activeExit;
  }

  function emitObservationVisibleEip(
    exitPoint: JitExitPoint,
    emitRuntimeVisibleEip: (() => void) | undefined
  ): void {
    switch (exitPoint.visibleEip.kind) {
      case "static":
        body.i32Const(i32(exitPoint.visibleEip.value));
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
