import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#ir/value-table.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { instantiateIrBlock, irBlockBody, irBlockCompleted } from "./harness.js";

test("a live producer before control executes even when its use is unselected", async () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const address = values.const(0xffff_ffff);
  const loaded = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        memoryRead(loaded, address, 32),
        {
          kind: "if",
          condition,
          thenBody: { actions: [stateWrite(gprChannel("eax"), loaded)] }
        }
      ]
    }
  };
  const { run } = await instantiateIrBlock(block, 1);

  throws(() => run(0), WebAssembly.RuntimeError);
});

test("a producer declared inside a body executes only on that selected body", async () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const address = values.const(0xffff_ffff);
  const loaded = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition,
        thenBody: {
          actions: [
            memoryRead(loaded, address, 32),
            stateWrite(gprChannel("eax"), loaded)
          ]
        }
      }]
    }
  };
  const { run } = await instantiateIrBlock(block, 1);

  strictEqual(run(0), irBlockCompleted);
  throws(() => run(1), WebAssembly.RuntimeError);
});

test("an unused memory read is omitted even when its address would trap", async () => {
  const values = new ValueTable();
  const address = values.const(0xffff_ffff);
  const loaded = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: { actions: [memoryRead(loaded, address, 32)] }
  };
  const encoded = irBlockBody(block).encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.drop), false);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);

  const { run } = await instantiateIrBlock(block);

  strictEqual(run(), irBlockCompleted);
});

test("an unused state read emits neither its opcode nor an output local", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: { actions: [stateRead(read, gprChannel("eax"))] }
  };
  const encoded = irBlockBody(block).encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.drop), false);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a live single-use output sets one local at its action and reads it", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(read, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), read)
      ]
    }
  };
  const encoded = irBlockBody(block).encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localSet).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localGet).length, 1);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("an output local preserves a read snapshot across an overlapping write", async () => {
  const values = new ValueTable();
  const snapshot = values.addActionOutput();
  const replacement = values.const(5);
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(snapshot, gprChannel("eax")),
        stateWrite(gprChannel("eax"), replacement),
        stateWrite(gprChannel("ebx"), snapshot)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 41, ebx: 0 });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 41);
});
