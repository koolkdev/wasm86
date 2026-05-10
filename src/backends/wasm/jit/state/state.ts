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
import {
  createJitFlagState,
  type JitFlagExitStoreSnapshot,
  type JitFlagState
} from "./flag-state.js";
import {
  createJitReg32State,
  type JitReg32State
} from "./register-state.js";
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

type ExitMetadataStoreOptions = Readonly<{
  allowPendingFlags?: boolean;
}>;

type JitIrStateOptions = Readonly<{
  valueCache?: JitValueCacheRuntime | undefined;
}>;

type JitExitMaterializationSnapshot = Readonly<{
  stores?: readonly JitCapturedExitMaterializationStore[];
  flags?: JitFlagExitStoreSnapshot;
}>;

type CaptureExitMaterializationOptions = Readonly<{
  allowPendingFlags?: boolean;
}>;

export type JitIrState = Readonly<{
  regs: JitReg32State;
  flags: JitFlagState;
  eipLocal: number;
  instructionCountLocal: number;
  maxExitMaterializationIndex: number;
  emitLoadInstructionCount(): void;
  beginInstruction(exit: JitExitTarget, entryPoint: JitInstructionEntryPoint): void;
  prepareExitPoint(exitPoint: JitExitPoint, emitEip: () => void): void;
  finishPreInstructionExitPoints(): void;
  commitInstruction(): void;
  commitInstructionExit(exitPoint: JitExitPoint, emitEip: () => void): void;
  emitExitMaterializationStores(index: number): void;
  releaseExitMaterialization(index: number): void;
}>;

export function createJitIrState(
  body: WasmFunctionBodyEncoder,
  exitMaterializations: readonly JitExitMaterializationPlan[],
  options: JitIrStateOptions = {}
): JitIrState {
  const regs = createJitReg32State(body);
  const maxExitMaterializationIndex = exitMaterializations.length - 1;
  const eipLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue,
    emitStoreAluFlags,
    valueCache: options.valueCache
  });
  const instructionCountLocal = body.addLocal(wasmValueType.i32);
  const exitMaterializationSnapshots = new Map<number, JitExitMaterializationSnapshot>();
  let activeExit: JitExitTarget | undefined;
  let pendingFlagOwnersReleased = false;

  return {
    regs,
    flags,
    eipLocal,
    instructionCountLocal,
    maxExitMaterializationIndex,
    emitLoadInstructionCount: () => {
      emitLoadStateU32(body, stateOffset.instructionCount);
      body.localSet(instructionCountLocal);
    },
    beginInstruction: (exit, entryPoint) => {
      const preInstructionExitPlan = entryPoint.preInstructionExitPlan;

      activeExit = exit;
      regs.beginInstruction({ preserveCommittedRegs: preInstructionExitPlan?.preserveCommittedRegs ?? false });
      useExitMaterialization(exit, 0);
      installExitMetadataStores(exit, () => {
        body.i32Const(i32(entryPoint.snapshot.eip));
      }, entryPoint.snapshot.instructionCountDelta);
    },
    prepareExitPoint: (exitPoint, emitEip) => {
      const exit = requiredActiveExit();
      const allowPendingFlags = exitPoint.snapshot.kind === "preInstruction";

      captureExitMaterialization(exitPoint.exitMaterializationIndex, {
        allowPendingFlags
      });

      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(exit, emitEip, exitPoint.snapshot.instructionCountDelta, {
        allowPendingFlags
      });
    },
    finishPreInstructionExitPoints: () => {
      regs.commitPending();
    },
    commitInstruction,
    commitInstructionExit: (exitPoint, emitEip) => {
      const exit = requiredActiveExit();

      emitEip();
      body.localSet(eipLocal);
      regs.commitPending();
      captureExitMaterialization(exitPoint.exitMaterializationIndex);
      useExitMaterialization(exit, exitPoint.exitMaterializationIndex);
      installExitMetadataStores(exit, () => {
        body.localGet(eipLocal);
      }, exitPoint.snapshot.instructionCountDelta, {
        allowPendingFlags: true
      });
    },
    emitExitMaterializationStores: (index) => {
      const plan = exitMaterializations[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit materialization: ${index}`);
      }

      const snapshot = exitMaterializationSnapshots.get(index);

      if (plan.stores.length !== 0) {
        if (snapshot?.stores === undefined) {
          throw new Error(`JIT exit materialization was not captured: ${index}`);
        }

        emitJitExitMaterializationStores({
          body,
          valueCache: options.valueCache
        }, snapshot.stores);
      }

      if (plan.flagMask !== 0) {
        if (snapshot?.flags === undefined) {
          throw new Error(`JIT flag exit materialization was not captured: ${index}`);
        }

        flags.emitExitSnapshotStore(snapshot.flags);
      }
    },
    releaseExitMaterialization: (index) => {
      const plan = exitMaterializations[index];

      if (plan === undefined) {
        throw new Error(`missing JIT exit materialization: ${index}`);
      }

      releasePendingFlagOwnersOnce();

      if (plan.stores.length === 0 && plan.flagMask === 0) {
        return;
      }

      const snapshot = exitMaterializationSnapshots.get(index);

      if (snapshot === undefined) {
        throw new Error(`JIT exit materialization was not captured: ${index}`);
      }

      if (snapshot.flags !== undefined) {
        flags.releaseExitSnapshot(snapshot.flags);
      }

      if (snapshot.stores !== undefined) {
        releaseJitExitMaterializationStores(snapshot.stores);
      }

      exitMaterializationSnapshots.delete(index);
    }
  };

  function commitInstruction(): void {
    regs.commitPending();
  }

  function emitLoadAluFlagsValue(): void {
    emitLoadStateU32(body, stateOffset.aluFlags);
  }

  function emitStoreAluFlags(emitValue: () => void): void {
    emitStoreStateU32(body, stateOffset.aluFlags, emitValue);
  }

  function installExitMetadataStores(
    exit: JitExitTarget,
    emitEip: () => void,
    instructionDelta: number,
    options: ExitMetadataStoreOptions = {}
  ): void {
    exit.emitBeforeExit = () => {
      emitStoreStateU32(body, stateOffset.eip, emitEip);
      emitStoreStateU32(body, stateOffset.instructionCount, () => {
        body.localGet(instructionCountLocal);

        if (instructionDelta !== 0) {
          body.i32Const(instructionDelta).i32Add();
        }
      });

      if (options.allowPendingFlags !== true) {
        flags.assertNoPending();
      }
    };
  }

  function useExitMaterialization(exit: JitExitTarget, index: number): void {
    exit.exitLabelDepth = maxExitMaterializationIndex - index;
  }

  function captureExitMaterialization(
    index: number,
    options: CaptureExitMaterializationOptions = {}
  ): void {
    if (exitMaterializationSnapshots.has(index)) {
      return;
    }

    const snapshot = captureExitMaterializationSnapshot(index, options);

    storeExitMaterializationSnapshot(index, snapshot);
  }

  function captureExitMaterializationSnapshot(
    index: number,
    captureOptions: CaptureExitMaterializationOptions = {}
  ): JitExitMaterializationSnapshot | undefined {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    if (captureOptions.allowPendingFlags !== true) {
      flags.assertPendingCoveredBy(plan.flagMask);
    }

    const storeSnapshot = captureJitExitMaterializationStores({
      body,
      valueCache: options.valueCache
    }, plan.stores);
    const flagSnapshot = flags.captureExitStoreSnapshot(
      plan.flagMask
    );

    return storeSnapshot === undefined && flagSnapshot === undefined
      ? undefined
      : {
          ...(storeSnapshot === undefined ? {} : { stores: storeSnapshot }),
          ...(flagSnapshot === undefined ? {} : { flags: flagSnapshot })
        };
  }

  function storeExitMaterializationSnapshot(
    index: number,
    snapshot: JitExitMaterializationSnapshot | undefined
  ): void {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    if (plan.stores.length === 0 && plan.flagMask === 0) {
      return;
    }

    if (snapshot === undefined) {
      throw new Error(`JIT exit materialization was not captured: ${index}`);
    }

    exitMaterializationSnapshots.set(index, snapshot);
  }

  function releasePendingFlagOwnersOnce(): void {
    if (pendingFlagOwnersReleased) {
      return;
    }

    pendingFlagOwnersReleased = true;
    flags.releasePendingOwners();
  }

  function requiredActiveExit(): JitExitTarget {
    if (activeExit === undefined) {
      throw new Error("JIT instruction exit requested before beginInstruction");
    }

    return activeExit;
  }
}
