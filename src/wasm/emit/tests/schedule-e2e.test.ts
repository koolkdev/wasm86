import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#ir/value-table.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  wasmBodyInstructions,
  wasmBodyLocalCount,
  wasmBodyOpcodes
} from "#compiler/encoder/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { instantiateIrBlock, irBlockBody, irBlockCompleted } from "./harness.js";

test("a single nested-body demand executes inside the selected body", async () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const address = values.external(1);
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
  const encoded = irBlockBody(block, 2).encode();
  const opcodes = wasmBodyOpcodes(encoded);
  const loadIndex = opcodes.indexOf(wasmOpcode.i32Load);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(loadIndex > ifIndex, true);
  const { guestView, run } = await instantiateIrBlock(block, 2);

  guestView.setUint32(0x100, 0x1234_5678, true);
  strictEqual(run(0, 0x100), irBlockCompleted);
  strictEqual(run(1, 0x100), irBlockCompleted);
});

test("a selected-body producer keeps its compound input in the body", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const base = values.external(1);
  const address = values.binary("add", base, values.const(4));
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
  const encoded = irBlockBody(block, 2).encode();
  const opcodes = wasmBodyOpcodes(encoded);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(opcodes.indexOf(wasmOpcode.i32Add) > ifIndex, true);
  strictEqual(opcodes.indexOf(wasmOpcode.i32Load) > ifIndex, true);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(opcodes.includes(wasmOpcode.localTee), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a producer declared inside a body executes only on that selected body", async () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const address = values.const(0x100);
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
  const { guestView, stateView, run } = await instantiateIrBlock(block, 1);

  guestView.setUint32(0x100, 0x1234_5678, true);
  strictEqual(run(0), irBlockCompleted);
  strictEqual(run(1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 0x1234_5678);
});

test("an unused memory read is omitted without a materialization event", async () => {
  const values = new ValueTable();
  const address = values.const(0x100);
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

test("a live single-use output materializes directly at its use", () => {
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

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localSet).length, 0);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localGet).length, 0);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a condition use tees once for a later selected-body use", async () => {
  const values = new ValueTable();
  const condition = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(condition, gprChannel("eax")),
        {
          kind: "if",
          condition,
          thenBody: { actions: [stateWrite(gprChannel("ebx"), condition)] }
        }
      ]
    }
  };
  const encoded = irBlockBody(block).encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localTee).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localSet).length, 0);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 1, ebx: 0 });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 1);
});

test("a trapping producer input still evaluates before a selected early exit", async () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const index = values.binary("div_u", values.const(1), values.external(1));
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, { kind: "gprDynamic", index, byteLength: 4 }),
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [{
              kind: "finish",
              finish: { kind: "exit", exit: { class: "host", reason: "hostTrap" } }
            }]
          }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).encode());
  const divideIndex = opcodes.indexOf(wasmOpcode.i32DivU);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(divideIndex >= 0 && divideIndex < ifIndex, true);

  const { run } = await instantiateIrBlock(block, 2);

  throws(() => run(1, 0), WebAssembly.RuntimeError);
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

test("a long straight-line sequence materializes each output directly", () => {
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
    0
  );
  strictEqual(
    localInstructions.filter((instruction) => instruction.opcode === wasmOpcode.localGet).length,
    0
  );
  strictEqual(wasmBodyLocalCount(encoded), 0);
  deepStrictEqual(localInstructions, []);
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

  strictEqual(wasmBodyLocalCount(encoded), 0);
  deepStrictEqual(outputSets, []);

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

  strictEqual(wasmBodyLocalCount(encoded), 1);
  deepStrictEqual(localInstructions, [
    [wasmOpcode.localSet, 2],
    [wasmOpcode.localGet, 0],
    [wasmOpcode.localGet, 2],
    [wasmOpcode.localGet, 1],
    [wasmOpcode.localGet, 2]
  ]);

  const { stateView, run } = await instantiateIrBlock(block, 2);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x41, ebx: 0, ecx: 0x99, edx: 0, esi: 0 });
  strictEqual(run(0, 1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x99);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x41);
});

test("dead nested producers do not recapture an already consumed output", () => {
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
  strictEqual(wasmBodyLocalCount(encoded), 0);
});
