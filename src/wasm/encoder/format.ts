import type { WasmValueType } from "#wasm/types.js";

export const wasmExternalKind = {
  function: 0x00,
  table: 0x01,
  memory: 0x02
} as const;

export const wasmFunctionTypePrefix = 0x60;

export const wasmMagic = [0x00, 0x61, 0x73, 0x6d] as const;

export const wasmSectionId = {
  custom: 0,
  type: 1,
  import: 2,
  function: 3,
  global: 6,
  export: 7,
  code: 10
} as const;

const wasmValueTypeCode: Readonly<Record<WasmValueType, number>> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c
};

export const wasmFunctionReferenceTypeCode = 0x70;

export const wasmVersion = [0x01, 0x00, 0x00, 0x00] as const;

export function encodeWasmValueType(type: WasmValueType): number {
  return wasmValueTypeCode[type];
}
