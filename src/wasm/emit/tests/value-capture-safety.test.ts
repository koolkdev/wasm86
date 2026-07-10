import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#ir/value-table.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#wasm/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import {
  instantiateFunctionBody,
  instantiateIrBlock,
  irBlockBody,
  irBlockCompleted
} from "./harness.js";

const unsupportedCapture = /value \d+ may trap and cannot be captured before a nested body is selected/;

test("a trapping value used only by a future then body is rejected", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition,
        thenBody: { actions: [stateWrite(gprChannel("eax"), quotient)] }
      }]
    }
  };

  throws(() => irBlockBody(block, 3), unsupportedCapture);
});

test("a transitively trapping wrapper used only by a future body is rejected", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const wrapped = values.binary("add", quotient, values.const(1));
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition,
        thenBody: { actions: [stateWrite(gprChannel("eax"), wrapped)] }
      }]
    }
  };

  throws(() => irBlockBody(block, 3), unsupportedCapture);
});

test("trapping switch arm results are rejected before emission", () => {
  for (const trappingArm of ["case", "default"] as const) {
    const values = new ValueTable();
    const selector = values.external(0);
    const quotient = values.binary("div_u", values.external(1), values.external(2));
    const safeResult = values.const(7);
    const output = values.addActionOutput();
    const block: IrBlock = {
      values,
      body: {
        actions: [
          {
            kind: "switch",
            selector,
            output,
            cases: [{
              match: 0,
              body: { actions: [], result: trappingArm === "case" ? quotient : safeResult }
            }],
            defaultBody: {
              actions: [],
              result: trappingArm === "default" ? quotient : safeResult
            }
          },
          stateWrite(gprChannel("eax"), output)
        ]
      }
    };

    throws(() => irBlockBody(block, 3), unsupportedCapture, trappingArm);
  }
});

test("a trapping value demanded directly by the current body still evaluates", async () => {
  const values = new ValueTable();
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const block: IrBlock = {
    values,
    body: { actions: [stateWrite(gprChannel("eax"), quotient)] }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).encode());
  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(run(84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("a trapping condition makes its selected wrapper safe to capture", async () => {
  const values = new ValueTable();
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const wrapped = values.binary("add", quotient, values.const(1));
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition: quotient,
        thenBody: { actions: [stateWrite(gprChannel("eax"), wrapped)] }
      }]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).encode());
  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(run(84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);

  writeWasmCpuStateSnapshot(stateView, { eax: 7 });
  strictEqual(run(0, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("an exported trapping value evaluates at the fragment boundary", async () => {
  const values = new ValueTable();
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const block: IrBlock = {
    values,
    body: { actions: [stateWrite(gprChannel("eax"), values.const(5))] }
  };
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new WasmLocalScratchAllocator(body);
  const resultLocal = scratch.allocLocal(wasmValueType.i32);

  emitActionFragment(block, {
    body,
    scratch,
    externalLocals: new Map([[0, 0], [1, 1]]),
    embedding: {
      fallthrough: { kind: "fallthrough" },
      outputs: new Map([[quotient, resultLocal]])
    }
  });
  body.localGet(resultLocal).i64ExtendI32U().end();
  scratch.freeLocal(resultLocal);
  scratch.assertClear();

  const { stateView, run } = await instantiateFunctionBody(body, 2);

  strictEqual(run(84, 2), 42n);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  throws(() => run(1, 0), WebAssembly.RuntimeError);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
});
