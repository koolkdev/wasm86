import type { FunctionType } from "#compiler/function/type.js";
import type { ValueKind } from "#compiler/function/values/expression.js";
import type { FloatWidth } from "#compiler/function/values/float/types.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { ValueType } from "#compiler/function/values/type.js";
import type {
  WasmFloatType,
  WasmFunctionType,
  WasmIntegerType,
  WasmIntegerWidth,
  WasmValueType
} from "#wasm/types.js";

type LogicalWidth = Readonly<{ integer: IntegerWidth; float: FloatWidth }>;
type WasmType = Readonly<{ integer: WasmIntegerType; float: WasmFloatType }>;

// Each value kind has one total projection from its logical widths to Wasm types.
const wasmTypeByWidth = {
  integer: { 1: "i32", 8: "i32", 16: "i32", 32: "i32", 64: "i64" },
  float: { 32: "f32", 64: "f64" }
} as const satisfies {
  [Kind in ValueKind]: Readonly<Record<LogicalWidth[Kind], WasmType[Kind]>>;
};

export function wasmValueTypeFor<Kind extends ValueKind>(
  kind: Kind,
  width: LogicalWidth[Kind]
): WasmType[Kind];
export function wasmValueTypeFor(kind: ValueKind, width: number): WasmValueType {
  // Each row is total over the width vocabulary its kind admits.
  return (wasmTypeByWidth[kind] as Readonly<Record<number, WasmValueType>>)[width]!;
}

type WasmIntegerTypeFor<Width extends IntegerWidth> = (typeof wasmTypeByWidth)["integer"][Width];

export function wasmIntegerType<Width extends IntegerWidth>(
  width: Width
): WasmIntegerTypeFor<Width> {
  return wasmTypeByWidth.integer[width];
}

// The Wasm representation remains 32 bits wide for every narrow logical integer.
export function wasmIntegerWidth(width: IntegerWidth): WasmIntegerWidth {
  return width === 64 ? 64 : 32;
}

export function toWasmFunctionType(type: FunctionType): WasmFunctionType {
  return {
    parameters: type.parameters.map(toWasmValueType),
    results: type.results.map(toWasmValueType)
  };
}

export function toWasmValueType(type: ValueType): WasmValueType {
  return wasmValueTypeFor(type.kind, type.width);
}
