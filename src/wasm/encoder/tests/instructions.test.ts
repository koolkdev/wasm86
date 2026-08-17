import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { ByteSink } from "#wasm/encoder/byte-sink.js";
import { createWasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";

test("float constants preserve raw bits and basic operators use their Wasm opcodes", () => {
  const sink = new ByteSink();
  const { writer } = createWasmInstructionWriter(sink);

  writer.write(wasmInstruction.f32.const, 0x7fc0_1234);
  writer.write(wasmInstruction.f64.const, 0x7ff8_0000_0000_1234n);
  for (const instruction of [
    wasmInstruction.f32.eq,
    wasmInstruction.f32.ne,
    wasmInstruction.f32.lt,
    wasmInstruction.f32.gt,
    wasmInstruction.f32.le,
    wasmInstruction.f32.ge,
    wasmInstruction.f32.add,
    wasmInstruction.f32.sub,
    wasmInstruction.f32.mul,
    wasmInstruction.f32.div,
    wasmInstruction.f64.eq,
    wasmInstruction.f64.ne,
    wasmInstruction.f64.lt,
    wasmInstruction.f64.gt,
    wasmInstruction.f64.le,
    wasmInstruction.f64.ge,
    wasmInstruction.f64.add,
    wasmInstruction.f64.sub,
    wasmInstruction.f64.mul,
    wasmInstruction.f64.div
  ]) {
    writer.write(instruction);
  }

  deepStrictEqual(
    [...sink.toBytes()],
    [
      0x43, 0x34, 0x12, 0xc0, 0x7f, 0x44, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x7f, 0x5b,
      0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x92, 0x93, 0x94, 0x95, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
      0xa0, 0xa1, 0xa2, 0xa3
    ]
  );
});

test("i64 memory instructions use their Wasm opcodes", () => {
  const sink = new ByteSink();
  const { writer } = createWasmInstructionWriter(sink);

  writer.write(wasmInstruction.i64.load, { align: 3, memoryIndex: 0, offset: 8 });
  writer.write(wasmInstruction.i64.store, { align: 3, memoryIndex: 0, offset: 8 });

  deepStrictEqual([...sink.toBytes()], [0x29, 0x03, 0x08, 0x37, 0x03, 0x08]);
});
