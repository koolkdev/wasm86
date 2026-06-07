import type { RegisterStateTarget } from "#ir/block/state/targets.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { type WasmValueType } from "#wasm/encoder/types.js";
import {
  emitLoadStateI32,
  emitStoreStateI32
} from "../../ops/state.js";
import { stateRegisterAliasPlacement } from "../../state/placement.js";
import type {
  WasmTargetStorage,
  WasmTargetValueProducer
} from "../storage.js";

export function createStateMemoryRegisterTargetStorage(
  body: WasmFunctionBodyEncoder
): WasmTargetStorage<RegisterStateTarget> {
  return {
    emitLoad: (target) => emitLoadStateRegisterTarget(body, target),
    emitStore: (target, emitValue) => {
      emitStoreStateRegisterTarget(body, target, emitValue);
    }
  };
}

function emitLoadStateRegisterTarget(
  body: WasmFunctionBodyEncoder,
  target: RegisterStateTarget
): WasmValueType {
  const placement = stateRegisterAliasPlacement(target.reg);

  return emitLoadStateI32(body, placement.offset, placement.width);
}

function emitStoreStateRegisterTarget(
  body: WasmFunctionBodyEncoder,
  target: RegisterStateTarget,
  emitValue: WasmTargetValueProducer
): void {
  const placement = stateRegisterAliasPlacement(target.reg);

  emitStoreStateI32(body, placement.offset, placement.width, emitValue);
}
