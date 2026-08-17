import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId, WasmValueNode } from "#compiler/wasm/function/values/nodes.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import { emitWasmValueInstruction } from "../value-instruction.js";
import { recordInstructions } from "./instruction-recorder.js";

type EmittableValueNode = Exclude<WasmValueNode, { kind: "producerOutput" | "loopInput" }>;

test("value sources emit their payloads in the target representation", () => {
  const values = new WasmValuesBuilder();
  const nodes = [
    values.constant(-7),
    values.constant64(-9n),
    values.constantBits("f32", 0x8000_0000),
    values.constantBits("f64", 0x3ff0_0000_0000_0000n),
    values.parameter(4, "i32"),
    values.unreachable("f64")
  ];
  const emitted = recordInstructions();

  for (const id of nodes) {
    emitWasmValueInstruction(emitted.writer, emittableNode(values, id));
  }

  deepStrictEqual(emitted.instructions, [
    { instruction: wasmInstruction.i32.const, arguments: [-7] },
    { instruction: wasmInstruction.i64.const, arguments: [-9n] },
    { instruction: wasmInstruction.f32.const, arguments: [0x8000_0000] },
    {
      instruction: wasmInstruction.f64.const,
      arguments: [0x3ff0_0000_0000_0000n]
    },
    { instruction: wasmInstruction.local.get, arguments: [4] },
    { instruction: wasmInstruction.control.unreachable, arguments: [] }
  ]);
});

test("typed value operations select their Wasm instructions", () => {
  const values = new WasmValuesBuilder();
  const i32 = values.parameter(0, "i32");
  const i64 = values.parameter(1, "i64");
  const f32 = values.parameter(2, "f32");
  const f64 = values.parameter(3, "f64");
  const operations = [
    values.unary("extend8_s", i32),
    values.unary("popcnt", i64),
    values.binary("rotl", i32, i32),
    values.binary("div", f32, f32),
    values.compare("ge_u", i64, i64),
    values.compare("lt", f64, f64),
    values.eqz(i64),
    values.convert("wrap_i64", i64),
    values.convert("extend_i32_s", i32),
    values.convert("extend_i32_u", i32),
    values.select(i32, f64, f64)
  ];
  const emitted = recordInstructions();

  for (const id of operations) {
    emitWasmValueInstruction(emitted.writer, emittableNode(values, id));
  }

  deepStrictEqual(emitted.instructions, [
    { instruction: wasmInstruction.i32.extend8S, arguments: [] },
    { instruction: wasmInstruction.i64.popcnt, arguments: [] },
    { instruction: wasmInstruction.i32.rotl, arguments: [] },
    { instruction: wasmInstruction.f32.div, arguments: [] },
    { instruction: wasmInstruction.i64.ge_u, arguments: [] },
    { instruction: wasmInstruction.f64.lt, arguments: [] },
    { instruction: wasmInstruction.i64.eqz, arguments: [] },
    { instruction: wasmInstruction.i32.wrapI64, arguments: [] },
    { instruction: wasmInstruction.i64.extendI32S, arguments: [] },
    { instruction: wasmInstruction.i64.extendI32U, arguments: [] },
    { instruction: wasmInstruction.parametric.select, arguments: [] }
  ]);
});

function emittableNode(values: WasmValuesBuilder, id: WasmValueId): EmittableValueNode {
  const node = values.node(id);

  strictEqual(node.kind === "producerOutput" || node.kind === "loopInput", false);
  return node as EmittableValueNode;
}
