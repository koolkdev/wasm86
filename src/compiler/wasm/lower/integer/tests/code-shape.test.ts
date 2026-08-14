import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { Integer } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { wasmValueId, type WasmValueNode } from "#compiler/wasm/function/values/nodes.js";
import { ValueLowerer } from "../../values.js";

test("shift counts omit conversions that retain every observed bit", () => {
  const values = new ValueResolver();
  const source = values.parameter(0, Integer[32]);
  const count = values.parameter(1, Integer[32]);
  const shifted = source.shl(count.truncate(8).unsigned.extend(32));
  const wasm = new WasmValuesBuilder();
  const shift = wasm.node(new ValueLowerer(values, wasm).lower(shifted));

  ok(shift.kind === "binary");
  strictEqual(shift.operator, "shl");
  deepStrictEqual(wasm.node(shift.inputs[1]), {
    kind: "parameter",
    inputs: [],
    index: 1,
    type: "i32"
  });
});

test("shift counts retain conversions that discard an observed bit", () => {
  const values = new ValueResolver();
  const source = values.parameter(0, Integer[32]);
  const count = values.parameter(1, Integer[32]);
  const shifted = source.shl(count.truncate(1).unsigned.extend(32));
  const wasm = new WasmValuesBuilder();
  const shift = wasm.node(new ValueLowerer(values, wasm).lower(shifted));

  ok(shift.kind === "binary");
  const countMask = wasm.node(shift.inputs[1]);

  ok(countMask.kind === "binary");
  strictEqual(countMask.operator, "and");
  deepStrictEqual(wasm.node(countMask.inputs[1]), {
    kind: "const",
    inputs: [],
    type: "i32",
    value: 1
  });
});

test("narrow equality retains dependency-first normalization order", () => {
  const values = new ValueResolver();
  const equal = values
    .parameter(0, Integer[32])
    .truncate(8)
    .eq(values.parameter(1, Integer[32]).truncate(8));
  const wasm = new WasmValuesBuilder();

  new ValueLowerer(values, wasm).lower(equal);
  deepStrictEqual(nodes(wasm), [
    { kind: "parameter", inputs: [], index: 0, type: "i32" },
    { kind: "parameter", inputs: [], index: 1, type: "i32" },
    { kind: "binary", inputs: [0, 1], operator: "xor", type: "i32" },
    { kind: "unary", inputs: [2], operator: "extend8_s", type: "i32" },
    { kind: "eqz", inputs: [3], inputType: "i32", type: "i32" }
  ]);
});

function nodes(wasm: WasmValuesBuilder): readonly WasmValueNode[] {
  const graph = wasm.finish();

  return Array.from({ length: graph.length }, (_, id) => graph.node(wasmValueId(id)));
}
