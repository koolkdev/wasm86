import type { ValueRef } from "#compiler/function/values.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

export function valueDomainsAreDistinct(value: ValueRef, wasmValue: WasmValueId): void {
  // @ts-expect-error Wasm values cannot enter the semantic value domain.
  const source: ValueRef = wasmValue;
  // @ts-expect-error Semantic values cannot enter the Wasm value domain.
  const wasm: WasmValueId = value;

  void [source, wasm];
}
