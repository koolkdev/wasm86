import type { FlagName } from "#ir/model/flags.js";
import type { WasmEmittedValue } from "../values/types.js";
import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlagsMask
} from "#x86/flags.js";
import { i32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { emitI32Boolean } from "./width.js";
import { wasmI32 } from "../values/types.js";

export type WasmPackedFlagValueProducer = () => WasmEmittedValue;

export function flagMask(flag: FlagName): number {
  return x86ArithmeticFlagMask[flag];
}

export function flagBitIndex(flag: FlagName): number {
  switch (flag) {
    case "CF":
      return 0;
    case "PF":
      return 1;
    case "AF":
      return 2;
    case "ZF":
      return 3;
    case "SF":
      return 4;
    case "OF":
      return 5;
  }
}

export function emitLoadPackedFlagFromStack(body: WasmFunctionBodyEncoder, flag: FlagName): WasmEmittedValue {
  body.i32Const(flagBitIndex(flag)).i32ShrU().i32Const(1).i32And();
  return wasmI32(8);
}

export function emitPackedFlagUpdateValue(
  body: WasmFunctionBodyEncoder,
  flag: FlagName,
  emitPackedValue: WasmPackedFlagValueProducer,
  emitValue: WasmPackedFlagValueProducer
): WasmEmittedValue {
  const mask = flagMask(flag);

  emitPackedValue();
  body.i32Const(i32(x86ArithmeticFlagsMask & ~mask)).i32And();
  emitValue();
  emitI32Boolean(body);
  body.i32Const(flagBitIndex(flag)).i32Shl().i32Or();
  return wasmI32(8);
}

export function emitStorePackedFlagToLocal(
  body: WasmFunctionBodyEncoder,
  local: number,
  flag: FlagName,
  emitValue: WasmPackedFlagValueProducer
): void {
  emitPackedFlagUpdateValue(
    body,
    flag,
    () => {
      body.localGet(local);
      return wasmI32(8);
    },
    emitValue
  );
  body.localSet(local);
}
