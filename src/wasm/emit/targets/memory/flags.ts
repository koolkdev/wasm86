import type { FlagStateTarget } from "#ir/block/state/targets.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  emitLoadPackedFlagFromStack,
  emitPackedFlagUpdateValue
} from "../../ops/flags.js";
import {
  emitLoadStateI32,
  emitStoreStateI32
} from "../../ops/state.js";
import { stateAluFlagsPlacement } from "../../state/placement.js";
import type { WasmTargetStorage } from "../storage.js";

export function createStateMemoryFlagTargetStorage(
  body: WasmFunctionBodyEncoder
): WasmTargetStorage<FlagStateTarget> {
  return {
    emitLoad: (target) => {
      const placement = stateAluFlagsPlacement();

      emitLoadStateI32(body, placement.offset, placement.width);
      return emitLoadPackedFlagFromStack(body, target.flag);
    },
    emitStore: (target, emitValue) => {
      const placement = stateAluFlagsPlacement();

      emitStoreStateI32(body, placement.offset, placement.width, () => {
        return emitPackedFlagUpdateValue(
          body,
          target.flag,
          () => emitLoadStateI32(body, placement.offset, placement.width),
          emitValue
        );
      });
    }
  };
}
