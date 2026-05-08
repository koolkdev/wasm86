import type { RegisterAlias, Reg32 } from "#x86/isa/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import {
  cloneRegValueState,
  fullRegAccess,
  type LocalRegValueSource,
  type RegValueState
} from "./register-values.js";
import {
  assertNoPending,
  commitPendingReg as commitPendingRegInStorage,
  createRegisterStateStorage,
  currentKnownPrefixForAlias,
  pendingRegs,
} from "./register-storage.js";
import { emitReadRegisterAlias } from "./register-read.js";
import { emitStoreRegState } from "./register-state-store.js";
import { createRegisterMaterializer } from "./register-materialization.js";
import { createRegisterWriter, type JitReg32WriteSource } from "./register-write.js";

export type JitReg32InstructionOptions = Readonly<{
  preserveCommittedRegs: boolean;
}>;

export type JitReg32ExitStoreSnapshot = ReadonlyMap<Reg32, RegValueState>;

export type JitReg32State = Readonly<{
  beginInstruction(options: JitReg32InstructionOptions): void;
  commitPending(): void;
  commitPendingReg(reg: Reg32): void;
  emitReadReg32(reg: Reg32): ValueWidth;
  emitReadAlias(alias: RegisterAlias, options?: WasmIrEmitValueOptions): ValueWidth;
  knownPrefixForAlias(alias: RegisterAlias): LocalRegValueSource | undefined;
  ensureStableFullValueForCopy(reg: Reg32): LocalRegValueSource;
  emitWriteAlias(alias: RegisterAlias, source: JitReg32WriteSource): void;
  captureCommittedExitStores(regs: readonly Reg32[]): JitReg32ExitStoreSnapshot;
  emitCommittedStore(reg: Reg32): void;
  emitExitSnapshotStore(target: Reg32, snapshot: JitReg32ExitStoreSnapshot, source?: Reg32): void;
}>;

export function createJitReg32State(body: WasmFunctionBodyEncoder): JitReg32State {
  const storage = createRegisterStateStorage();
  const materializer = createRegisterMaterializer(body, storage);
  let preserveCommittedRegs = false;
  const writer = createRegisterWriter(body, storage, materializer, () => preserveCommittedRegs);

  return {
    beginInstruction: (options) => {
      assertNoPending(storage);
      preserveCommittedRegs = options.preserveCommittedRegs;
    },
    emitReadReg32: (reg) => emitReadAlias(fullRegAccess(reg)),
    emitReadAlias,
    knownPrefixForAlias: (alias) => currentKnownPrefixForAlias(storage, alias),
    ensureStableFullValueForCopy: materializer.ensureStableFullValueForCopy,
    emitWriteAlias: writer.emitWriteAlias,
    captureCommittedExitStores,
    commitPending,
    commitPendingReg,
    emitCommittedStore,
    emitExitSnapshotStore: (target, snapshot, source = target) => {
      const state = snapshot.get(source);

      if (state === undefined) {
        throw new Error(`JIT register snapshot has no state for ${source}`);
      }

      emitStoreRegState(body, target, state);
    }
  };

  function emitReadAlias(alias: RegisterAlias, options: WasmIrEmitValueOptions = {}): ValueWidth {
    return emitReadRegisterAlias(body, storage, materializer, alias, options);
  }

  function captureCommittedExitStores(regs: readonly Reg32[]): JitReg32ExitStoreSnapshot {
    const snapshot = new Map<Reg32, RegValueState>();

    for (const reg of regs) {
      materializer.freezeCommittedRegister(reg);

      const state = storage.committedStates.get(reg);

      if (state === undefined) {
        throw new Error(`dirty JIT register has no committed state: ${reg}`);
      }

      snapshot.set(reg, cloneRegValueState(state));
    }

    return snapshot;
  }

  function commitPending(): void {
    for (const reg of pendingRegs(storage)) {
      commitPendingReg(reg);
    }

    preserveCommittedRegs = false;
  }

  function commitPendingReg(reg: Reg32): void {
    commitPendingRegInStorage(storage, reg);
  }

  function emitCommittedStore(reg: Reg32): void {
    materializer.freezeCommittedRegister(reg);

    const state = storage.committedStates.get(reg);

    if (state === undefined) {
      throw new Error(`dirty JIT register has no committed state: ${reg}`);
    }

    emitStoreRegState(body, reg, state);
  }
}
