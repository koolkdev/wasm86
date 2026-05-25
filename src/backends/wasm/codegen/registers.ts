import { widthMask, type OperandWidth, type RegisterAlias, type Reg32 } from "#x86/isa/types.js";
import { i32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  cleanValueWidth,
  dirtyValueWidth,
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "./value-width.js";

export { emitMaskValueToWidth } from "./value-width.js";

export type WasmIrReg32Storage = Readonly<{
  emitGet(reg: Reg32): void;
  emitSet(reg: Reg32, emitValue: () => void): void;
}>;

export function wasmIrLocalReg32Storage(
  body: WasmFunctionBodyEncoder,
  locals: Readonly<Record<Reg32, number>>
): WasmIrReg32Storage {
  return {
    emitGet: (reg) => {
      body.localGet(locals[reg]);
    },
    emitSet: (reg, emitValue) => {
      emitValue();
      body.localSet(locals[reg]);
    }
  };
}

export function emitLoadRegAlias(
  body: WasmFunctionBodyEncoder,
  locals: Readonly<Record<Reg32, number>>,
  alias: RegisterAlias,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  body.localGet(locals[alias.base]);
  return emitExtractRegAliasFromStack(body, alias, options);
}

export function emitStoreRegAlias(
  body: WasmFunctionBodyEncoder,
  locals: Readonly<Record<Reg32, number>>,
  alias: RegisterAlias,
  emitValue: () => ValueWidth | void
): void {
  if (alias.width === 32) {
    emitCleanValueForFullUse(body, emitValue() ?? undefined);
    body.localSet(locals[alias.base]);
    return;
  }

  const shiftedMask = widthMask(alias.width) << alias.bitOffset;

  body.localGet(locals[alias.base]).i32Const(i32(~shiftedMask)).i32And();
  emitMaskValueToWidth(body, alias.width, emitValue() ?? undefined);

  if (alias.bitOffset !== 0) {
    body.i32Const(alias.bitOffset).i32Shl();
  }

  body.i32Or().localSet(locals[alias.base]);
}

export function emitLoadRegAccess(
  body: WasmFunctionBodyEncoder,
  locals: Readonly<Record<Reg32, number>>,
  reg: Reg32,
  width: OperandWidth,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  body.localGet(locals[reg]);

  if (options.signed === true && width < 32) {
    return emitSignExtendValueToWidth(body, width as 8 | 16);
  }

  if (options.widthInsensitive === true && width < 32) {
    return dirtyValueWidth(width);
  }

  return emitMaskValueToWidth(body, width);
}

export function emitStoreRegAccess(
  body: WasmFunctionBodyEncoder,
  locals: Readonly<Record<Reg32, number>>,
  reg: Reg32,
  width: OperandWidth,
  emitValue: () => ValueWidth | void
): void {
  emitStoreRegAlias(body, locals, { name: reg, base: reg, bitOffset: 0, width }, emitValue);
}

export function emitExtractRegAliasFromStack(
  body: WasmFunctionBodyEncoder,
  alias: RegisterAlias,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  if (alias.bitOffset !== 0) {
    body.i32Const(alias.bitOffset).i32ShrU();
  }

  if (options.signed === true && alias.width < 32) {
    return emitSignExtendValueToWidth(body, alias.width as 8 | 16);
  }

  if (options.widthInsensitive === true && alias.width < 32) {
    return dirtyValueWidth(alias.width);
  }

  emitMaskValueToWidth(body, alias.width);
  return cleanValueWidth(alias.width);
}
