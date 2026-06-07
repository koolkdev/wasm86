import { assert } from "#common/assert.js";
import { WASM_STATE_OFFSETS } from "#wasm/state-layout.js";
import type {
  OperandWidth,
  Reg32,
  RegisterAlias
} from "#x86/types.js";

export type WasmStateI32Placement = Readonly<{
  offset: number;
  width: OperandWidth;
}>;

export function stateRegisterBasePlacement(reg: Reg32): WasmStateI32Placement {
  return {
    offset: WASM_STATE_OFFSETS[reg],
    width: 32
  };
}

export function stateRegisterAliasPlacement(alias: RegisterAlias): WasmStateI32Placement {
  assert(
    alias.bitOffset % 8 === 0,
    `state-memory register ${alias.name} has non-byte bit offset ${alias.bitOffset}`
  );

  return {
    offset: WASM_STATE_OFFSETS[alias.base] + (alias.bitOffset / 8),
    width: alias.width
  };
}

export function stateAluFlagsPlacement(): WasmStateI32Placement {
  return {
    offset: WASM_STATE_OFFSETS.aluFlags,
    width: 32
  };
}
