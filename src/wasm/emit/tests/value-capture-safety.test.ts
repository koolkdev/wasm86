import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  instantiateFunctionBody,
  instantiateIrBlock,
  irBlockBody,
  irBlockCompleted
} from "./harness.js";

test("a trapping value used only by a future then body stays in that body", async () => {
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

  const { stateView, run } = await instantiateIrBlock(block, 3);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  strictEqual(run(0, 1, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
  strictEqual(run(1, 84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});

test("a transitively trapping wrapper used only by a future body stays in that body", async () => {
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

  const { stateView, run } = await instantiateIrBlock(block, 3);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  strictEqual(run(0, 1, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
  strictEqual(run(1, 84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});

test("trapping switch arm results evaluate only when selected", async () => {
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

    const { stateView, run } = await instantiateIrBlock(block, 3);
    const safeSelector = trappingArm === "case" ? 1 : 0;
    const trappingSelector = trappingArm === "case" ? 0 : 1;

    strictEqual(run(safeSelector, 1, 0), irBlockCompleted, trappingArm);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7, trappingArm);
    strictEqual(run(trappingSelector, 84, 2), irBlockCompleted, trappingArm);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42, trappingArm);
    throws(() => run(trappingSelector, 1, 0), WebAssembly.RuntimeError, trappingArm);
  }
});

test("a trapping value demanded directly by the current body still evaluates", async () => {
  const values = new ValueTable();
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const block: IrBlock = {
    values,
    body: { actions: [stateWrite(gprChannel("eax"), quotient)] }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);
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
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);
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
  body.localGet(resultLocal).i64ExtendI32U();
  scratch.freeLocal(resultLocal);
  scratch.assertClear();
  const encoded = body.finish();

  const { stateView, run } = await instantiateFunctionBody(encoded, 2);

  strictEqual(run(84, 2), 42n);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  throws(() => run(1, 0), WebAssembly.RuntimeError);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
});
