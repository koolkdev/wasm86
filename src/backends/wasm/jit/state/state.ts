import { i32 } from "#x86/state/cpu-state.js";
import { stateOffset } from "#backends/wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitLoadStateU32, emitStoreStateU32 } from "#backends/wasm/codegen/state.js";
import type {
  JitExitMaterializationPlan,
  JitExitPoint,
  JitInstructionEntryPoint
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

type JitExitMaterializationSnapshot = readonly JitCapturedExitMaterializationStore[];

export type JitIrState = Readonly<{
  eipLocal: number;
  instructionCountLocal: number;
  maxExitMaterializationIndex: number;
  emitLoadInstructionCount(): void;
  beginInstruction(exit: JitExitTarget, entryPoint: JitInstructionEntryPoint): void;
  prepareExitPoint(exitPoint: JitExitPoint, emitEip: () => void): void;
  commitInstructionExit(exitPoint: JitExitPoint, emitEip: () => void): void;
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
  const exitMaterializationSnapshots = new Map<number, JitExitMaterializationSnapshot>();
  let activeExit: JitExitTarget | undefined;

  return {
    eipLocal,
    instructionCountLocal,
    maxExitMaterializationIndex,
    emitLoadInstructionCount: () => {
      emitLoadStateU32(body, stateOffset.instructionCount);
      body.localSet(instructionCountLocal);
    },
    beginInstruction: (exit, entryPoint) => {
      activeExit = exit;
      useExitMaterialization(exit, 0);
      installExitMetadataStores(exit, () => {
        body.i32Const(i32(entryPoint.snapshot.eip));
      }, entryPoint.snapshot.instructionCountDelta);
    },
    prepareExitPoint: (exitPoint, emitEip) => {
      const exit = requiredActiveExit();

      captureExitMaterialization(exitPoint.exitMaterializationIndex);

      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(exit, emitEip, exitPoint.snapshot.instructionCountDelta);
    },
    commitInstructionExit: (exitPoint, emitEip) => {
      const exit = requiredActiveExit();

      emitEip();
      body.localSet(eipLocal);
      captureExitMaterialization(exitPoint.exitMaterializationIndex);
      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(exit, () => {
        body.localGet(eipLocal);
      }, exitPoint.snapshot.instructionCountDelta);
    },
    emitExitMaterializationStores: (index) => {
      const plan = exitMaterializations[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit materialization: ${index}`);
      }

      const snapshot = exitMaterializationSnapshots.get(index);

      if (plan.stores.length !== 0) {
        if (snapshot === undefined) {
          throw new Error(`JIT exit materialization was not captured: ${index}`);
        }

        emitJitExitMaterializationStores({
          body,
          valueCache: options.valueCache
        }, snapshot);
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

      const snapshot = exitMaterializationSnapshots.get(index);

      if (snapshot === undefined) {
        throw new Error(`JIT exit materialization was not captured: ${index}`);
      }

      releaseJitExitMaterializationStores(snapshot);

      exitMaterializationSnapshots.delete(index);
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
    if (exitMaterializationSnapshots.has(index)) {
      return;
    }

    const snapshot = captureExitMaterializationSnapshot(index);

    storeExitMaterializationSnapshot(index, snapshot);
  }

  function captureExitMaterializationSnapshot(index: number): JitExitMaterializationSnapshot | undefined {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    const storeSnapshot = captureJitExitMaterializationStores({
      body,
      valueCache: options.valueCache
    }, plan.stores);

    return storeSnapshot;
  }

  function storeExitMaterializationSnapshot(
    index: number,
    snapshot: JitExitMaterializationSnapshot | undefined
  ): void {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    if (plan.stores.length === 0) {
      return;
    }

    if (snapshot === undefined) {
      throw new Error(`JIT exit materialization was not captured: ${index}`);
    }

    exitMaterializationSnapshots.set(index, snapshot);
  }

  function requiredActiveExit(): JitExitTarget {
    if (activeExit === undefined) {
      throw new Error("JIT instruction exit requested before beginInstruction");
    }

    return activeExit;
  }
}
