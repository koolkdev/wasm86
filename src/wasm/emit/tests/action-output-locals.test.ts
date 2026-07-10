import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#ir/value-table.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import {
  wasmBodyInstructions,
  wasmBodyLocalCount,
  wasmBodyOpcodes
} from "#wasm/tests/body-opcodes.js";
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

test("a long straight-line sequence reuses one physical output local", () => {
  const values = new ValueTable();
  const actions: Action[] = [];
  const outputCount = 64;

  for (let index = 0; index < outputCount; index += 1) {
    const output = values.addActionOutput();

    actions.push(
      stateRead(output, gprChannel("eax")),
      stateWrite(gprChannel("ebx"), output)
    );
  }

  const encoded = irBlockBody({ values, body: { actions } }).encode();
  const localInstructions = wasmBodyInstructions(encoded)
    .filter((instruction) => instruction.local !== undefined);

  strictEqual(
    localInstructions.filter((instruction) => instruction.opcode === wasmOpcode.localSet).length,
    outputCount
  );
  strictEqual(
    localInstructions.filter((instruction) => instruction.opcode === wasmOpcode.localGet).length,
    outputCount
  );
  strictEqual(wasmBodyLocalCount(encoded), 1);
  deepStrictEqual(new Set(localInstructions.map((instruction) => instruction.local)), new Set([0]));
});

test("sibling bodies reuse a local after the earlier binding's final reference", async () => {
  const values = new ValueTable();
  const firstCondition = values.external(0);
  const secondCondition = values.external(1);
  const first = values.addActionOutput();
  const second = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "if",
          condition: firstCondition,
          thenBody: {
            actions: [
              stateRead(first, gprChannel("eax")),
              stateWrite(gprChannel("ebx"), first)
            ]
          }
        },
        {
          kind: "if",
          condition: secondCondition,
          thenBody: {
            actions: [
              stateRead(second, gprChannel("ecx")),
              stateWrite(gprChannel("edx"), second)
            ]
          }
        }
      ]
    }
  };
  const encoded = irBlockBody(block, 2).encode();
  const outputSets = wasmBodyInstructions(encoded)
    .filter((instruction) => instruction.opcode === wasmOpcode.localSet)
    .map((instruction) => instruction.local);

  strictEqual(wasmBodyLocalCount(encoded), 1);
  deepStrictEqual(outputSets, [2, 2]);

  const { stateView, run } = await instantiateIrBlock(block, 2);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11, ebx: 0, ecx: 0x22, edx: 0 });
  strictEqual(run(1, 1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 0x11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x22);
});

test("an output used by both siblings cannot recycle between them", async () => {
  const values = new ValueTable();
  const firstCondition = values.external(0);
  const secondCondition = values.external(1);
  const snapshot = values.addActionOutput();
  const interloper = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(snapshot, gprChannel("eax")),
        {
          kind: "if",
          condition: firstCondition,
          thenBody: { actions: [stateWrite(gprChannel("ebx"), snapshot)] }
        },
        stateRead(interloper, gprChannel("ecx")),
        stateWrite(gprChannel("edx"), interloper),
        {
          kind: "if",
          condition: secondCondition,
          thenBody: { actions: [stateWrite(gprChannel("esi"), snapshot)] }
        }
      ]
    }
  };
  const encoded = irBlockBody(block, 2).encode();
  const localInstructions = wasmBodyInstructions(encoded)
    .filter((instruction) => instruction.local !== undefined)
    .map((instruction) => [instruction.opcode, instruction.local] as const);

  strictEqual(wasmBodyLocalCount(encoded), 2);
  deepStrictEqual(localInstructions, [
    [wasmOpcode.localSet, 2],
    [wasmOpcode.localGet, 0],
    [wasmOpcode.localGet, 2],
    [wasmOpcode.localSet, 3],
    [wasmOpcode.localGet, 3],
    [wasmOpcode.localGet, 1],
    [wasmOpcode.localGet, 2]
  ]);

  const { stateView, run } = await instantiateIrBlock(block, 2);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x41, ebx: 0, ecx: 0x99, edx: 0, esi: 0 });
  strictEqual(run(0, 1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x99);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x41);
});

test("a reclaimed output tombstone covers dead nested producer inputs", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const base = values.addActionOutput();
  const deadLoad = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(base, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), base),
        {
          kind: "if",
          condition,
          thenBody: { actions: [memoryRead(deadLoad, base, 32)] }
        }
      ]
    }
  };
  const encoded = irBlockBody(block, 1).encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Load).length, 1);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});
