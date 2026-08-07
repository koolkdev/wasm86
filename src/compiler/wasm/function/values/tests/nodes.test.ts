import { deepStrictEqual, notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";
import { WasmValuesBuilder } from "../builder.js";
import { wasmValueSource } from "../nodes.js";

test("Wasm value sources distinguish inline leaves, produced outputs, and expressions", () => {
  const values = new WasmValuesBuilder();
  const parameter = values.parameter(0, "i32");
  const loopInput = values.loopInput("i32", 1);
  const output = values.producerOutput("i32", 0);
  const expression = values.binary("add", parameter, values.constant(1));
  const { graph } = values.finish();

  strictEqual(wasmValueSource(graph.node(parameter)), "inline");
  strictEqual(wasmValueSource(graph.node(loopInput)), "inline");
  strictEqual(wasmValueSource(graph.node(output)), "output");
  strictEqual(wasmValueSource(graph.node(expression)), "expression");
});

test("float Wasm types mint the shared node kinds with their own alphabet", () => {
  const values = new WasmValuesBuilder();
  const parameter = values.parameter(0, "f32");
  const two = values.constantBits("f32", 0x4000_0000);
  const sum = values.binary("add", parameter, two);
  const positive = values.compare("gt", sum, values.constantBits("f32", 0));
  const wide = values.constantBits("f64", 0x3ff0_0000_0000_0000n);
  const { graph } = values.finish();

  deepStrictEqual(graph.node(two), {
    kind: "const",
    type: "f32",
    inputs: [],
    bits: 0x4000_0000
  });
  deepStrictEqual(graph.node(wide), {
    kind: "const",
    type: "f64",
    inputs: [],
    bits: 0x3ff0_0000_0000_0000n
  });
  deepStrictEqual(graph.node(sum), {
    kind: "binary",
    type: "f32",
    inputs: [parameter, two],
    operator: "add"
  });
  deepStrictEqual(graph.node(positive), {
    kind: "compare",
    type: "i32",
    inputType: "f32",
    inputs: [sum, values.constantBits("f32", 0)],
    operator: "gt"
  });
  strictEqual(wasmValueSource(graph.node(two)), "inline");
  strictEqual(wasmValueSource(graph.node(sum)), "expression");
  strictEqual(wasmValueSource(graph.node(positive)), "expression");
});

test("float values carry no required bits while their comparisons do", () => {
  const values = new WasmValuesBuilder();
  const parameter = values.parameter(0, "f64");
  const doubled = values.binary("mul", parameter, values.constantBits("f64", 0x4000n));
  const equal = values.compare("eq", parameter, doubled);

  throws(() => values.requiredBits(parameter), /required bits are an integer fact/);
  throws(() => values.requiredBits(doubled), /required bits are an integer fact/);
  deepStrictEqual(values.requiredBits(equal), { unsigned: 1, signed: 2 });
});

test("float constants intern by bit pattern, so positive and negative zero differ", () => {
  const values = new WasmValuesBuilder();
  const zero = values.constantBits("f32", 0);
  const negativeZero = values.constantBits("f32", 0x8000_0000);

  strictEqual(values.constantBits("f32", 0), zero);
  notStrictEqual(negativeZero, zero);
});
