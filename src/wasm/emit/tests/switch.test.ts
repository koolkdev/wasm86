import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { instantiateIrBlock, irBlockBody, irBlockCompleted } from "./harness.js";

// The value switch: br_table dispatch over one block per case plus default
// plus a join, with the selected arm's result delivered as the output.

test("a switch selects arms by match and falls back to the default", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const first = values.const(11);
  const second = values.const(42);
  const fallback = values.const(99);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            { match: 0, body: { actions: [], result: first } },
            { match: 2, body: { actions: [], result: second } }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 1);
  const expectations = [
    [0, 11],
    [2, 42],
    // A hole in the dense table and an out-of-range selector both land on
    // the default.
    [1, 99],
    [7, 99]
  ] as const;

  for (const [selectorValue, expected] of expectations) {
    strictEqual(run(selectorValue), irBlockCompleted);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      expected,
      `selector ${selectorValue}`
    );
  }
});

test("sequential switch joins reuse one physical local", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const firstCase = values.const(11);
  const firstFallback = values.const(12);
  const secondCase = values.const(21);
  const secondFallback = values.const(22);
  const firstOutput = values.addActionOutput();
  const secondOutput = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output: firstOutput,
          cases: [{ match: 0, body: { actions: [], result: firstCase } }],
          defaultBody: { actions: [], result: firstFallback }
        },
        stateWrite(gprChannel("eax"), firstOutput),
        {
          kind: "switch",
          selector,
          output: secondOutput,
          cases: [{ match: 0, body: { actions: [], result: secondCase } }],
          defaultBody: { actions: [], result: secondFallback }
        },
        stateWrite(gprChannel("ebx"), secondOutput)
      ]
    }
  };
  const encoded = irBlockBody(block, 1).bytes;

  strictEqual(wasmBodyLocalCount(encoded), 1);

  const { stateView, run } = await instantiateIrBlock(block, 1);

  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 21);

  strictEqual(run(7), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 12);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 22);
});

test("an impossible default lowers to unreachable and traps", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const first = values.const(11);
  const impossible = values.unreachable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [{ match: 0, body: { actions: [], result: first } }],
          defaultBody: { actions: [], result: impossible }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 1);

  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  throws(() => run(5), WebAssembly.RuntimeError);
});

test("an arm-local compound over an arm-local read computes inside the arm", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const formula = values.binary("add", read, values.const(1));
  const fallback = values.const(99);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            { match: 0, body: { actions: [stateRead(read, gprChannel("ebx"))], result: formula } }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 1).bytes);

  // No if-chain lowering, one br_table; the ebx load sits inside the arm,
  // after dispatch — never captured in the parent.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.if), false);
  ok(opcodes.indexOf(wasmOpcode.i32Load) > opcodes.indexOf(wasmOpcode.brTable));

  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { ebx: 41 });
  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
});

test("a parent compound consumed by two arms captures once before the switch", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const shared = values.binary("add", values.external(1), values.const(5));
  const fallback = values.const(99);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            { match: 0, body: { actions: [], result: shared } },
            { match: 1, body: { actions: [], result: shared } }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);

  // One computation, captured before dispatch and replayed by each arm.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Add).length, 1);
  ok(opcodes.indexOf(wasmOpcode.i32Add) < opcodes.indexOf(wasmOpcode.brTable));

  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(run(1, 37), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
});

test("a dead switch output emits no arm values but keeps the impossible default", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const readFormula = values.binary("add", read, values.const(1));
  const shared = values.binary("add", values.external(1), values.const(5));
  const impossible = values.unreachable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            { match: 0, body: { actions: [stateRead(read, gprChannel("ebx"))], result: readFormula } },
            { match: 1, body: { actions: [], result: shared } }
          ],
          defaultBody: { actions: [], result: impossible }
        }
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);

  // Nothing demands the output: the dispatch shell remains, but no arm
  // result materializes — neither the pure arm read nor the parent-context
  // compound — while the impossible default still traps.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Add), false);

  const { run } = await instantiateIrBlock(block, 2);

  strictEqual(run(0, 37), irBlockCompleted);
  strictEqual(run(1, 37), irBlockCompleted);
  throws(() => run(9, 37), WebAssembly.RuntimeError);
});

test("a dispatch inside an arm escapes through the switch's labels", async () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const condition = values.external(1);
  const target = values.const(0x2000);
  const delivered = values.const(7);
  const fallback = values.const(99);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            {
              match: 0,
              body: {
                actions: [
                  {
                    kind: "if",
                    condition,
                    thenBody: {
                      actions: [
                        { kind: "finish", finish: { kind: "dispatch", targetEip: target } }
                      ]
                    }
                  }
                ],
                result: delivered
              }
            }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(run(0, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);

  // The dispatch escapes the switch's labels before the arm delivers:
  // eax keeps its old value and eip carries the flushed target.
  strictEqual(run(0, 1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x2000);
});
