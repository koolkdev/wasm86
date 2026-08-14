import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../builder.js";
import { wasmValueId } from "../nodes.js";

test("Wasm value sources retain their representation and integer bounds", () => {
  const values = new WasmValuesBuilder();
  const constant = values.constant(-1);
  const wideConstant = values.constant64(-1n);
  const floatConstant = values.constantBits("f32", 0x8000_0000);
  const parameter = values.parameter(0, "i32");
  const output = values.producerOutput("i32", { unsigned: 8, signed: 9 });
  const loopInput = values.loopInput("i64");
  const unreachable = values.unreachable("f64");
  const graph = values.finish();

  deepStrictEqual(graph.node(constant), {
    kind: "const",
    type: "i32",
    inputs: [],
    value: -1
  });
  deepStrictEqual(graph.node(wideConstant), {
    kind: "const",
    type: "i64",
    inputs: [],
    value: -1n
  });
  deepStrictEqual(graph.node(floatConstant), {
    kind: "const",
    type: "f32",
    inputs: [],
    bits: 0x8000_0000
  });
  deepStrictEqual(graph.node(parameter), {
    kind: "parameter",
    type: "i32",
    inputs: [],
    index: 0
  });
  deepStrictEqual(graph.node(output), {
    kind: "producerOutput",
    type: "i32",
    inputs: []
  });
  deepStrictEqual(graph.node(loopInput), {
    kind: "loopInput",
    type: "i64",
    inputs: []
  });
  deepStrictEqual(graph.node(unreachable), {
    kind: "unreachable",
    type: "f64",
    inputs: []
  });

  deepStrictEqual(values.requiredBits(constant), { unsigned: 32, signed: 1 });
  deepStrictEqual(values.requiredBits(wideConstant), { unsigned: 64, signed: 1 });
  deepStrictEqual(values.requiredBits(parameter), { unsigned: 32, signed: 32 });
  deepStrictEqual(values.requiredBits(output), { unsigned: 8, signed: 9 });
  deepStrictEqual(values.requiredBits(loopInput), { unsigned: 64, signed: 64 });
});

test("Wasm expressions retain their operations and integer bounds", () => {
  const values = new WasmValuesBuilder();
  const byte = values.producerOutput("i32", { unsigned: 8, signed: 9 });
  const word = values.producerOutput("i32", { unsigned: 16, signed: 17 });
  const condition = values.parameter(0, "i32");
  const signed = values.unary("extend8_s", byte);
  const population = values.unary("popcnt", byte);
  const shift = values.constant(2);
  const shifted = values.binary("shl", byte, shift);
  const equal = values.compare("eq", byte, word);
  const wide = values.convert("extend_i32_u", byte);
  const zero = values.eqz(wide);
  const selected = values.select(condition, byte, word);
  const floatLeft = values.parameter(1, "f32");
  const floatRight = values.parameter(2, "f32");
  const floatSum = values.binary("add", floatLeft, floatRight);
  const floatLess = values.compare("lt", floatLeft, floatRight);
  const graph = values.finish();

  deepStrictEqual(graph.node(signed), {
    kind: "unary",
    inputs: [byte],
    type: "i32",
    operator: "extend8_s"
  });
  deepStrictEqual(graph.node(shifted), {
    kind: "binary",
    inputs: [byte, shift],
    type: "i32",
    operator: "shl"
  });
  deepStrictEqual(graph.node(equal), {
    kind: "compare",
    inputs: [byte, word],
    type: "i32",
    inputType: "i32",
    operator: "eq"
  });
  deepStrictEqual(graph.node(wide), {
    kind: "convert",
    inputs: [byte],
    type: "i64",
    operator: "extend_i32_u"
  });
  deepStrictEqual(graph.node(zero), {
    kind: "eqz",
    inputs: [wide],
    type: "i32",
    inputType: "i64"
  });
  deepStrictEqual(graph.node(selected), {
    kind: "select",
    inputs: [byte, word, condition],
    type: "i32"
  });
  deepStrictEqual(graph.node(floatSum), {
    kind: "binary",
    inputs: [floatLeft, floatRight],
    type: "f32",
    operator: "add"
  });
  deepStrictEqual(graph.node(floatLess), {
    kind: "compare",
    inputs: [floatLeft, floatRight],
    type: "i32",
    inputType: "f32",
    operator: "lt"
  });

  deepStrictEqual(values.requiredBits(signed), { unsigned: 32, signed: 8 });
  deepStrictEqual(values.requiredBits(population), { unsigned: 6, signed: 7 });
  deepStrictEqual(values.requiredBits(shifted), { unsigned: 10, signed: 11 });
  deepStrictEqual(values.requiredBits(equal), { unsigned: 1, signed: 2 });
  deepStrictEqual(values.requiredBits(wide), { unsigned: 8, signed: 9 });
  deepStrictEqual(values.requiredBits(zero), { unsigned: 1, signed: 2 });
  deepStrictEqual(values.requiredBits(selected), { unsigned: 16, signed: 17 });
  deepStrictEqual(values.requiredBits(floatLess), { unsigned: 1, signed: 2 });
});

test("Wasm expressions form a dependency-topological graph in operand order", () => {
  const values = new WasmValuesBuilder();
  const condition = values.parameter(0, "i32");
  const source = values.parameter(1, "i32");
  const increment = values.constant(1);
  const sum = values.binary("add", source, increment);
  const result = values.select(condition, sum, source);
  const graph = values.finish();

  deepStrictEqual(graph.node(result).inputs, [sum, source, condition]);
  for (let index = 0; index < graph.length; index += 1) {
    strictEqual(
      graph.node(wasmValueId(index)).inputs.every((input) => input < index),
      true
    );
  }
});
