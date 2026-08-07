import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { select, type I32Value } from "#compiler/function/values.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import { wasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { Integer } from "#compiler/function/values/type.js";
import { ValueLowerer } from "../../values.js";

test("shift counts bypass representation conversions that retain every observed bit", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const count = values.parameter(1, Integer[32]);
  const shifted = source.shl(count.truncate(8).unsigned.extend(32));

  values.resolve(shifted);

  const wasm = new WasmValuesBuilder();
  const result = new ValueLowerer(values, wasm).lower(shifted);
  const shift = wasm.node(result);

  ok(shift.kind === "binary");
  strictEqual(shift.operator, "shl");
  deepStrictEqual(wasm.node(shift.inputs[0]), {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
  deepStrictEqual(wasm.node(shift.inputs[1]), {
    kind: "parameter",
    inputs: [],
    index: 1,
    type: "i32"
  });
  strictEqual(wasm.finish().graph.length, 3);
});

test("shift counts retain conversions that discard an observed bit", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const count = values.parameter(1, Integer[32]);
  const shifted = source.shl(count.truncate(1).unsigned.extend(32));

  values.resolve(shifted);

  const wasm = new WasmValuesBuilder();
  const result = new ValueLowerer(values, wasm).lower(shifted);
  const shift = wasm.node(result);

  ok(shift.kind === "binary");
  strictEqual(shift.operator, "shl");
  const countMask = wasm.node(shift.inputs[1]);

  ok(countMask.kind === "binary");
  strictEqual(countMask.operator, "and");
  deepStrictEqual(wasm.node(countMask.inputs[0]), {
    kind: "parameter",
    inputs: [],
    index: 1,
    type: "i32"
  });
  deepStrictEqual(wasm.node(countMask.inputs[1]), {
    kind: "const",
    inputs: [],
    type: "i32",
    value: 1
  });
});

test("select recipes retain condition-first evaluation order", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const selected = select(
    source.eqz(),
    source.add(values.parameter(1, Integer[32])),
    source.sub(values.parameter(2, Integer[32]))
  );

  values.resolve(selected);

  const wasm = new WasmValuesBuilder();

  new ValueLowerer(values, wasm).lower(selected);
  deepStrictEqual(wasmNodes(wasm), [
    { kind: "parameter", inputs: [], index: 0, type: "i32" },
    { kind: "eqz", inputs: [0], inputType: "i32", type: "i32" },
    { kind: "parameter", inputs: [], index: 1, type: "i32" },
    { kind: "binary", inputs: [0, 2], operator: "add", type: "i32" },
    { kind: "parameter", inputs: [], index: 2, type: "i32" },
    { kind: "binary", inputs: [0, 4], operator: "sub", type: "i32" },
    { kind: "select", inputs: [3, 5, 1], type: "i32" }
  ]);
});

test("narrow equality retains operand-first normalization order", () => {
  const values = new ValueScope();
  const equal = values
    .parameter(0, Integer[32])
    .truncate(8)
    .eq(values.parameter(1, Integer[32]).truncate(8));

  values.resolve(equal);

  const wasm = new WasmValuesBuilder();

  new ValueLowerer(values, wasm).lower(equal);
  deepStrictEqual(wasmNodes(wasm), [
    { kind: "parameter", inputs: [], index: 0, type: "i32" },
    { kind: "parameter", inputs: [], index: 1, type: "i32" },
    { kind: "binary", inputs: [0, 1], operator: "xor", type: "i32" },
    { kind: "unary", inputs: [2], operator: "extend8_s", type: "i32" },
    { kind: "eqz", inputs: [3], inputType: "i32", type: "i32" }
  ]);
});

test("low-bit specialization retains dependency-first node order", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const mask = values.parameter(1, Integer[32]);
  const byte = source.and(mask).unsigned.shr(1).truncate(8);

  values.resolve(byte);

  const wasm = new WasmValuesBuilder();

  new ValueLowerer(values, wasm).lower(byte);
  deepStrictEqual(wasmNodes(wasm), [
    { kind: "parameter", inputs: [], index: 0, type: "i32" },
    { kind: "parameter", inputs: [], index: 1, type: "i32" },
    { kind: "binary", inputs: [0, 1], operator: "and", type: "i32" },
    { kind: "const", inputs: [], type: "i32", value: 1 },
    { kind: "binary", inputs: [2, 3], operator: "shr_u", type: "i32" }
  ]);
});

test("deep base chains retain condition-first node order without duplicates", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const increment = values.parameter(3, Integer[32]);
  let value: I32Value = select(
    source.eqz(),
    source.add(values.parameter(1, Integer[32])),
    source.sub(values.parameter(2, Integer[32]))
  );

  for (let index = 0; index < 600; index += 1) {
    value = value.add(increment);
  }
  values.resolve(value);

  const wasm = new WasmValuesBuilder();
  const result = new ValueLowerer(values, wasm).lower(value);
  const { graph } = wasm.finish();

  strictEqual(result, 607);
  strictEqual(graph.length, 608);
  deepStrictEqual(graph.node(wasmValueId(6)), {
    kind: "select",
    inputs: [3, 5, 1],
    type: "i32"
  });
  deepStrictEqual(graph.node(wasmValueId(8)), {
    kind: "binary",
    inputs: [6, 7],
    operator: "add",
    type: "i32"
  });
  deepStrictEqual(graph.node(result), {
    kind: "binary",
    inputs: [606, 7],
    operator: "add",
    type: "i32"
  });
});

test("deep low-bit chains retain dependency-first node order", () => {
  const values = new ValueScope();
  const mask = values.parameter(1, Integer[32]);
  let value: I32Value = values.parameter(0, Integer[32]);

  for (let index = 0; index < 600; index += 1) {
    value = value.and(mask);
  }
  const byte = value.truncate(8);

  values.resolve(byte);

  const wasm = new WasmValuesBuilder();
  const result = new ValueLowerer(values, wasm).lower(byte);
  const { graph } = wasm.finish();

  strictEqual(result, 601);
  deepStrictEqual(graph.node(wasmValueId(2)), {
    kind: "binary",
    inputs: [0, 1],
    operator: "and",
    type: "i32"
  });
  deepStrictEqual(graph.node(result), {
    kind: "binary",
    inputs: [600, 1],
    operator: "and",
    type: "i32"
  });
});

function wasmNodes(wasm: WasmValuesBuilder): readonly unknown[] {
  const { graph } = wasm.finish();

  return Array.from({ length: graph.length }, (_, id) => graph.node(wasmValueId(id)));
}
