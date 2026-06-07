import { assert } from "#common/assert.js";
import type { RegisterStateTarget } from "#ir/block/state/targets.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { Reg32 } from "#x86/types.js";
import type { WasmTargetStorage } from "../storage.js";
import { wasmI32 } from "../../values/types.js";

export type WasmRegisterLocalMap = Readonly<Record<Reg32, number>>;

export function createLocalRegisterTargetStorage(
  body: WasmFunctionBodyEncoder,
  locals: WasmRegisterLocalMap
): WasmTargetStorage<RegisterStateTarget> {
  return {
    emitLoad: (target) => {
      const base = fullBaseRegisterTarget(target);

      body.localGet(locals[base]);
      return wasmI32(32);
    },
    emitStore: (target, emitValue) => {
      const base = fullBaseRegisterTarget(target);

      emitValue();
      body.localSet(locals[base]);
    }
  };
}

function fullBaseRegisterTarget(target: RegisterStateTarget): Reg32 {
  assert(
    target.reg.width === 32 && target.reg.bitOffset === 0 && target.reg.name === target.reg.base,
    `local-backed register target storage requires full 32-bit base register target, got ${target.reg.name}`
  );

  return target.reg.base;
}
