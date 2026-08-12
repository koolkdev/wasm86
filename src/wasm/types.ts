export type WasmIntegerWidth = 32 | 64;
export type WasmIntegerType = "i32" | "i64";
export type WasmFloatType = "f32" | "f64";
export type WasmValueType = WasmIntegerType | WasmFloatType;

export function isWasmIntegerType(type: WasmValueType): type is WasmIntegerType {
  return type === "i32" || type === "i64";
}

export function wasmIntegerTypeWidth(type: WasmIntegerType): WasmIntegerWidth {
  switch (type) {
    case "i32":
      return 32;
    case "i64":
      return 64;
  }
}

export type WasmFunctionType = Readonly<{
  parameters: readonly WasmValueType[];
  results: readonly WasmValueType[];
}>;
