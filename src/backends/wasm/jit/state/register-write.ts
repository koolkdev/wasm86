import type { OperandWidth, RegisterAlias } from "#x86/isa/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import {
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import {
  clearRegValueState,
  fullWidth,
  recordRegValueSource,
  recordStableRegValue,
  type LocalRegValueSource
} from "./register-values.js";
import {
  emitComposedPrefixLocal,
  emitStoreAliasValueIntoFullLocal
} from "./register-prefix-emit.js";
import type { RegisterMaterializer } from "./register-materialization.js";
import {
  clearWritableMutableCell,
  currentKnownPrefixForReg,
  writableStateForReg,
  type RegisterStateStorage
} from "./register-storage.js";

export type JitReg32WriteSource = (() => ValueWidth | void) | Readonly<{
  emitValue: () => ValueWidth | void;
  prefixSource?: LocalRegValueSource | undefined;
}>;

export type RegisterWriter = Readonly<{
  emitWriteAlias(alias: RegisterAlias, source: JitReg32WriteSource): void;
}>;

export function createRegisterWriter(
  body: WasmFunctionBodyEncoder,
  storage: RegisterStateStorage,
  materializer: RegisterMaterializer,
  getPreserveCommittedRegs: () => boolean
): RegisterWriter {
  return {
    emitWriteAlias
  };

  function emitWriteAlias(alias: RegisterAlias, source: JitReg32WriteSource): void {
    const writeSource = normalizeWriteSource(source);
    const preserveCommittedRegs = getPreserveCommittedRegs();
    const currentPrefix = currentKnownPrefixForReg(storage, alias.base);
    const state = writableStateForReg(storage, alias.base, preserveCommittedRegs);

    if (alias.width === fullWidth) {
      if (writeSource.prefixSource !== undefined) {
        if (writeSource.prefixSource.width !== fullWidth) {
          throw new Error(`full-register writes need a 32-bit prefix source, got ${writeSource.prefixSource.width}`);
        }

        clearWritableMutableCell(storage, alias.base, preserveCommittedRegs);
        recordRegValueSource(state, writeSource.prefixSource);
        return;
      }

      emitCleanValueForFullUse(body, writeSource.emitValue() ?? undefined);
      const local = body.addLocal(wasmValueType.i32);

      body.localSet(local);
      clearWritableMutableCell(storage, alias.base, preserveCommittedRegs);
      recordStableRegValue(state, local, fullWidth);
      return;
    }

    if (alias.bitOffset !== 0) {
      // High-byte and other non-prefix aliases fall back to a mutable full register.
      const fullLocal = materializer.ensureMutableCell(alias.base, preserveCommittedRegs);
      const valueLocal = localForMaskedValue(alias.width, writeSource.emitValue);

      emitStoreAliasValueIntoFullLocal(body, fullLocal, alias, valueLocal);
      clearRegValueState(state);
      return;
    }

    const valueLocal = localForMaskedValue(alias.width, writeSource.emitValue);
    const composedWidth = composedWriteWidth(currentPrefix, alias.width);

    if (composedWidth !== undefined && currentPrefix !== undefined) {
      // Keep AL/AX writes in the prefix model by composing them into the known low bits.
      const composedLocal = emitComposedPrefixLocal(body, currentPrefix, valueLocal, alias.width);

      recordStableRegValue(state, composedLocal, composedWidth);

      if (composedWidth === fullWidth) {
        clearWritableMutableCell(storage, alias.base, preserveCommittedRegs);
      }
      return;
    }

    recordStableRegValue(state, valueLocal, alias.width);
  }

  function localForMaskedValue(width: OperandWidth, emitValue: () => ValueWidth | void): number {
    const local = body.addLocal(wasmValueType.i32);

    emitMaskValueToWidth(body, width, emitValue() ?? undefined);
    body.localSet(local);
    return local;
  }
}

function composedWriteWidth(
  currentPrefix: LocalRegValueSource | undefined,
  writeWidth: OperandWidth
): 16 | 32 | undefined {
  if (currentPrefix?.width === 32 && (writeWidth === 8 || writeWidth === 16)) {
    return 32;
  }

  if (currentPrefix?.width === 16 && writeWidth === 8) {
    return 16;
  }

  return undefined;
}

function normalizeWriteSource(source: JitReg32WriteSource): Readonly<{
  emitValue: () => ValueWidth | void;
  prefixSource?: LocalRegValueSource | undefined;
}> {
  return typeof source === "function" ? { emitValue: source } : source;
}
