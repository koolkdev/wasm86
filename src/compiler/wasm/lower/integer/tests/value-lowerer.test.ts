import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { integer, nonzero } from "#compiler/function/values.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import { Integer } from "#compiler/function/values/type.js";
import { ValueLowerer } from "../../values.js";

test("nonzero keeps separate condition and data selections", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const predicate = nonzero(source);

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = lowerer.condition(predicate);
  const data = lowerer.lower(predicate);
  const conditionNode = wasm.node(condition);
  const dataNode = wasm.node(data);

  deepStrictEqual(conditionNode, {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
  ok(dataNode.kind === "eqz");
  const zero = wasm.node(dataNode.inputs[0]);

  ok(zero.kind === "eqz");
  deepStrictEqual(wasm.node(zero.inputs[0]), {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
});

test("a narrow nonzero condition observes only its logical low bits", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const predicate = nonzero(source.truncate(8));

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = wasm.node(lowerer.condition(predicate));

  ok(condition.kind === "binary");
  strictEqual(condition.operator, "and");
  deepStrictEqual(wasm.node(condition.inputs[0]), {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
  const mask = wasm.node(condition.inputs[1]);

  deepStrictEqual(mask, {
    kind: "const",
    inputs: [],
    type: "i32",
    value: 0xff
  });
});

test("an i64 nonzero condition produces an i32 predicate", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[64]);
  const predicate = nonzero(source);

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = wasm.node(lowerer.condition(predicate));

  ok(condition.kind === "eqz");
  strictEqual(condition.type, "i32");
  const zero = wasm.node(condition.inputs[0]);

  ok(zero.kind === "eqz");
  strictEqual(zero.type, "i32");
  strictEqual(wasm.node(zero.inputs[0]).type, "i64");
});

test("nonzero data stays i32 when its i64 operand is already canonical", () => {
  const values = new ValueScope();
  const bit = values.parameter(0, Integer[1]);
  const predicate = nonzero(bit.unsigned.extend(64));

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const data = wasm.node(lowerer.lower(predicate));

  strictEqual(data.type, "i32");
});

test("eqz keeps its canonical zero test in condition context", () => {
  const values = new ValueScope();
  const source = values.parameter(0, Integer[32]);
  const predicate = source.eqz();

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = wasm.node(lowerer.condition(predicate));

  ok(condition.kind === "eqz");
  deepStrictEqual(wasm.node(condition.inputs[0]), {
    kind: "parameter",
    inputs: [],
    index: 0,
    type: "i32"
  });
});

test("predicate constants select canonical i32 constants directly", () => {
  const values = new ValueScope();
  const predicate = integer(1, 1);

  values.resolve(predicate);

  const wasm = new WasmValuesBuilder();
  const lowerer = new ValueLowerer(values, wasm);
  const condition = lowerer.condition(predicate);

  deepStrictEqual(wasm.node(condition), {
    kind: "const",
    inputs: [],
    type: "i32",
    value: 1
  });
});
