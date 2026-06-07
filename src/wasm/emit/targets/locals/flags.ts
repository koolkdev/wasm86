import type { FlagStateTarget } from "#ir/block/state/targets.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  emitLoadPackedFlagFromStack,
  emitStorePackedFlagToLocal
} from "../../ops/flags.js";
import type { WasmTargetStorage } from "../storage.js";

export function createLocalFlagTargetStorage(
  body: WasmFunctionBodyEncoder,
  aluFlagsLocal: number
): WasmTargetStorage<FlagStateTarget> {
  return {
    emitLoad: (target) => {
      body.localGet(aluFlagsLocal);
      return emitLoadPackedFlagFromStack(body, target.flag);
    },
    emitStore: (target, emitValue) => {
      emitStorePackedFlagToLocal(body, aluFlagsLocal, target.flag, emitValue);
    }
  };
}
