import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  wasmValueId,
  wasmValueSource,
  type WasmValueNode
} from "#compiler/wasm/function/values/nodes.js";

test("Wasm value nodes distinguish inline values, outputs, and expressions", () => {
  const input = wasmValueId(0);
  const nodes: readonly WasmValueNode[] = [
    { kind: "const", type: "i32", inputs: [], value: 1 },
    { kind: "parameter", type: "i32", inputs: [], index: 0 },
    { kind: "loopInput", type: "i32", inputs: [] },
    { kind: "unreachable", type: "i32", inputs: [] },
    { kind: "producerOutput", type: "i32", inputs: [] },
    { kind: "unary", type: "i32", inputs: [input], operator: "clz" }
  ];

  deepStrictEqual(nodes.map(wasmValueSource), [
    "inline",
    "inline",
    "inline",
    "inline",
    "output",
    "expression"
  ]);
});
