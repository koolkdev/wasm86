import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";

export type WasmIrAluFlagsStorage = Readonly<{
  emitLoad(): void;
  emitStore(emitValue: () => void): void;
}>;

export function wasmIrLocalAluFlagsStorage(
  body: WasmFunctionBodyEncoder,
  local: number
): WasmIrAluFlagsStorage {
  return {
    emitLoad: () => {
      body.localGet(local);
    },
    emitStore: (emitValue) => {
      emitValue();
      body.localSet(local);
    }
  };
}
