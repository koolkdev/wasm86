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

export const wasmValueType = {
  funcref: 0x70,
  i32: 0x7f,
  i64: 0x7e
} as const;

export const wasmVersion = [0x01, 0x00, 0x00, 0x00] as const;

export type WasmValueType = (typeof wasmValueType)[keyof typeof wasmValueType];

export type WasmFunctionType = Readonly<{
  params: readonly WasmValueType[];
  results: readonly WasmValueType[];
}>;
