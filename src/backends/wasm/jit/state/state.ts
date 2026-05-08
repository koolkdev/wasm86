import { i32 } from "#x86/state/cpu-state.js";
import { stateOffset } from "#backends/wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
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
  type JitReg32State,
  type JitReg32ExitStoreSnapshot
} from "./register-state.js";
import type { JitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";

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
  regs?: JitReg32ExitStoreSnapshot;
  flags?: JitFlagExitStoreSnapshot;
}>;

type CaptureExitMaterializationOptions = Readonly<{
  allowPendingFlags?: boolean;
  consumeFlags?: boolean;
}>;

export type JitIrState = Readonly<{
  regs: JitReg32State;
  flags: JitFlagState;
  eipLocal: number;
  aluFlagsLocal: number;
  instructionCountLocal: number;
  maxExitMaterializationIndex: number;
  emitLoadInstructionCount(): void;
  beginInstruction(exit: JitExitTarget, entryPoint: JitInstructionEntryPoint): void;
  prepareExitPoint(exitPoint: JitExitPoint, emitEip: () => void): void;
  finishPreInstructionExitPoints(): void;
  commitInstruction(): void;
  commitInstructionExit(exitPoint: JitExitPoint, emitEip: () => void): void;
  emitExitMaterializationStores(index: number): void;
}>;

export function createJitIrState(
  body: WasmFunctionBodyEncoder,
  exitMaterializations: readonly JitExitMaterializationPlan[],
  options: JitIrStateOptions = {}
): JitIrState {
  const regs = createJitReg32State(body);
  const maxExitMaterializationIndex = exitMaterializations.length - 1;
  const eipLocal = body.addLocal(wasmValueType.i32);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags,
    emitLoadAluFlagsValue,
    emitStoreAluFlags,
    valueCache: options.valueCache
  });
  const instructionCountLocal = body.addLocal(wasmValueType.i32);
  const exitMaterializationSnapshots = new Map<number, JitExitMaterializationSnapshot>();
  let activeExit: JitExitTarget | undefined;

  return {
    regs,
    flags,
    eipLocal,
    aluFlagsLocal,
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
      const snapshot = captureExitMaterializationSnapshot(exitPoint.exitMaterializationIndex, {
        allowPendingFlags
      });

      storeExitMaterializationSnapshot(exitPoint.exitMaterializationIndex, snapshot);
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
      captureAndStoreExitMaterialization(exitPoint.exitMaterializationIndex, {
        consumeFlags: shouldConsumeExitFlags(exitPoint)
      });
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

      if (plan.regs.length !== 0) {
        if (snapshot?.regs === undefined) {
          throw new Error(`JIT exit materialization was not captured: ${index}`);
        }

        for (const reg of plan.regs) {
          regs.emitExitSnapshotStore(reg, snapshot.regs);
        }
      }

      if (plan.flagMask !== 0) {
        if (snapshot?.flags === undefined) {
          throw new Error(`JIT flag exit materialization was not captured: ${index}`);
        }

        flags.emitExitSnapshotStore(snapshot.flags);
      }
    }
  };

  function commitInstruction(): void {
    regs.commitPending();
  }

  function emitLoadAluFlags(): void {
    emitLoadAluFlagsValue();
    body.localSet(aluFlagsLocal);
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

  function captureAndStoreExitMaterialization(
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
    options: CaptureExitMaterializationOptions = {}
  ): JitExitMaterializationSnapshot | undefined {
    const plan = exitMaterializations[index];

    if (plan === undefined) {
      throw new Error(`missing JIT exit materialization: ${index}`);
    }

    if (options.allowPendingFlags !== true) {
      flags.assertPendingCoveredBy(plan.flagMask);
    }

    const registerSnapshot = plan.regs.length === 0
      ? undefined
      : regs.captureCommittedExitStores(plan.regs);
    const flagSnapshot = flags.captureExitStoreSnapshot(
      plan.flagMask,
      options.consumeFlags === false ? { consume: false } : undefined
    );

    return registerSnapshot === undefined && flagSnapshot === undefined
      ? undefined
      : {
          ...(registerSnapshot === undefined ? {} : { regs: registerSnapshot }),
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

    if (plan.regs.length === 0 && plan.flagMask === 0) {
      return;
    }

    if (snapshot === undefined) {
      throw new Error(`JIT exit materialization was not captured: ${index}`);
    }

    exitMaterializationSnapshots.set(index, snapshot);
  }

  function shouldConsumeExitFlags(exitPoint: JitExitPoint): boolean {
    // emitJitConditionalJump emits the taken arm first and not-taken second.
    // Keep the first arm non-consuming so the second arm can still snapshot
    // pending flags, then let the second arm consume and release ownership.
    return exitPoint.exitReason !== ExitReason.BRANCH_TAKEN;
  }

  function requiredActiveExit(): JitExitTarget {
    if (activeExit === undefined) {
      throw new Error("JIT instruction exit requested before beginInstruction");
    }

    return activeExit;
  }
}
