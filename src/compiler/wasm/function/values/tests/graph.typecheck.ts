import type { ValueRef } from "#compiler/function/values.js";
import type { WasmValueId } from "../nodes.js";
import { WasmValuesBuilder } from "../builder.js";
import type { WasmValueGraph } from "../graph.js";

export function wasmValueGraphTypeContract(
  graph: WasmValueGraph,
  sourceValue: ValueRef,
  wasm: WasmValueId
): void {
  const values = new WasmValuesBuilder();
  const parameter: WasmValueId = values.parameter(0, "i32");
  values.producerOutput("i32", 0, { unsigned: 8, signed: 9 });
  values.producerOutput("i64", 0, { unsigned: 8, signed: 9 });
  values.loopInput("i32", 1);
  const result: WasmValueId = values.eqz(parameter);

  graph.node(wasm);

  // @ts-expect-error Wasm graphs reject source value references.
  graph.node(sourceValue);
  // @ts-expect-error Wasm builders reject source value references.
  values.eqz(sourceValue);
  // @ts-expect-error Wasm allocations cannot enter the source value space.
  const wrongSourceValue: ValueRef = result;
  // @ts-expect-error loop inputs cannot claim required-bit refinements across backedges.
  values.loopInput("i32", { unsigned: 8, signed: 9 });

  void wrongSourceValue;
}
