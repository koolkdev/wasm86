import type { FloatRef } from "#compiler/function/values/reference.js";
import type { ValueRecord } from "#compiler/function/values/record.js";
import type { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmValueTypeFor } from "#compiler/wasm/type-lowering.js";

type FloatOperation = Extract<
  ValueRecord,
  { op: "float.constant" | "float.binary" | "float.compare" }
>;

type FloatLowering = Readonly<{
  wasm: WasmValuesBuilder;
  lower(value: FloatRef): WasmValueId;
}>;

export function lowerFloatOperation(record: FloatOperation, lowering: FloatLowering): WasmValueId {
  switch (record.op) {
    case "float.constant":
      return lowering.wasm.constantBits(wasmValueTypeFor(record.kind, record.width), record.attr);
    case "float.binary":
      return lowering.wasm.binary(record.attr, lowering.lower(record.a), lowering.lower(record.b));
    case "float.compare":
      return lowering.wasm.compare(record.attr, lowering.lower(record.a), lowering.lower(record.b));
  }
}
