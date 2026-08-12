import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../builder.js";

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
