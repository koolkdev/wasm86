import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { Float, Integer, nonzero } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { ValueLowerer } from "../values.js";

test("narrow parameters keep their zero-filled internal representation", () => {
  const values = new ValueResolver();
  const byte = values.parameter(2, Integer[8]);
  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const base = lowerer.lower(byte);

  deepStrictEqual(wasm.node(base), {
    kind: "parameter",
    inputs: [],
    index: 2,
    type: "i32"
  });
  deepStrictEqual(wasm.requiredBits(base), { unsigned: 8, signed: 9 });
  strictEqual(lowerer.normalize(byte, "unsigned"), base);
  strictEqual(wasm.finish().length, 1);
});

test("bound producer values retain their target representation", () => {
  const values = new ValueResolver();
  const byte = values.producer(Integer[8]);
  const wasm = new WasmValuesBuilder();
  const output = wasm.producerOutput("i32", { unsigned: 8, signed: 9 });
  const lowerer = new ValueLowerer(values, wasm);

  lowerer.bind(byte, output);
  strictEqual(lowerer.lower(byte), output);
  strictEqual(lowerer.normalize(byte, "unsigned"), output);
});

test("float expressions map to typed Wasm operations", () => {
  const values = new ValueResolver();
  const source = values.parameter(0, Float[32]);
  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const sum = wasm.node(lowerer.lower(source.add(1)));

  ok(sum.kind === "binary");
  strictEqual(sum.type, "f32");
  strictEqual(sum.operator, "add");
  deepStrictEqual(wasm.node(sum.inputs[1]), {
    kind: "const",
    inputs: [],
    type: "f32",
    bits: 0x3f800000
  });

  const comparison = wasm.node(lowerer.lower(source.lt(0)));

  ok(comparison.kind === "compare");
  strictEqual(comparison.inputType, "f32");
  strictEqual(comparison.type, "i32");
});

test("conditions can use a nonzero value without materializing its data result", () => {
  const values = new ValueResolver();
  const source = values.parameter(0, Integer[32]);
  const predicate = nonzero(source);
  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = lowerer.condition(predicate);
  const data = wasm.node(lowerer.lower(predicate));

  deepStrictEqual(wasm.node(condition), {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
  ok(data.kind === "eqz");
  const zero = wasm.node(data.inputs[0]);

  ok(zero.kind === "eqz");
  strictEqual(zero.inputs[0], condition);
});

test("narrow conditions observe only their logical low bits", () => {
  const values = new ValueResolver();
  const source = values.parameter(0, Integer[32]);
  const wasm = new WasmValuesBuilder();
  const condition = wasm.node(
    new ValueLowerer(values, wasm).condition(nonzero(source.truncate(8)))
  );

  ok(condition.kind === "binary");
  strictEqual(condition.operator, "and");
  deepStrictEqual(wasm.node(condition.inputs[1]), {
    kind: "const",
    inputs: [],
    type: "i32",
    value: 0xff
  });
});
