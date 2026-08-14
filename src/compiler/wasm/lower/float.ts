import type { FloatExpression, FloatRef } from "#compiler/function/values/expression.js";
import type { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmValueTypeFor } from "#compiler/wasm/type-mapping.js";

type FloatOperation = Extract<
  FloatExpression,
  { op: "float.constant" | "float.binary" | "float.compare" }
>;

type FloatLowering = Readonly<{
  wasm: WasmValuesBuilder;
  lower(value: FloatRef): WasmValueId;
}>;

export function lowerFloatOperation(
  expression: FloatOperation,
  lowering: FloatLowering
): WasmValueId {
  switch (expression.op) {
    case "float.constant":
      return lowering.wasm.constantBits(
        wasmValueTypeFor(expression.kind, expression.width),
        expression.attr
      );
    case "float.binary":
      return lowering.wasm.binary(
        expression.attr,
        lowering.lower(expression.a),
        lowering.lower(expression.b)
      );
    case "float.compare":
      return lowering.wasm.compare(
        expression.attr,
        lowering.lower(expression.a),
        lowering.lower(expression.b)
      );
  }
}
