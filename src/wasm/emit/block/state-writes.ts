import type { WasmTargetStorage } from "../targets/storage.js";
import type {
  WasmStateWriteEmitter,
  WasmStateWriteEmitInput
} from "./types.js";

export type WasmStateWriteEmitterInput = Readonly<{
  storage: WasmTargetStorage;
}>;

export function createWasmStateWriteEmitter(
  input: WasmStateWriteEmitterInput
): WasmStateWriteEmitter {
  return {
    emitStateWrite: (write) => emitStateWrite(input.storage, write)
  };
}

function emitStateWrite(
  storage: WasmTargetStorage,
  input: WasmStateWriteEmitInput
): void {
  if (input.write.value === undefined) {
    return;
  }

  storage.emitStore(input.write.target, () => input.emitValue());
}
