import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { operandWrite } from "#ir/tests/storage-op-helpers.js";
import { gprChannel } from "#core/state/channels.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { createModuleBindings } from "#compiler/program/bindings.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { cpuState, cpuStateAccess } from "#cpu/state.js";
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
import {
  ifControl,
  switchControl
} from "#compiler/ir/controls/index.js";

test("a trapping value used only by a future then body stays in that body", async () => {
  const values = new ValueTable();
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition,
        thenBody: { nodes: [operandWrite(state.gpr("eax"), quotient)] }
      })]
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
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const wrapped = values.binary("add", quotient, values.const(1));
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition,
        thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] }
      })]
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
    const state = cpuStateAccess.bind(new RegionBuilder(values));
    const selector = values.external(0);
    const quotient = values.binary("div_u", values.external(1), values.external(2));
    const safeResult = values.const(7);
    const output = values.addNodeOutput();
    const block: IrBlock = {
      values,
      body: {
        nodes: [
          switchControl.create({
            selector,
            output,
            cases: [{
              matches: [0],
              body: { nodes: [], result: trappingArm === "case" ? quotient : safeResult }
            }],
            defaultBody: {
              nodes: [],
              result: trappingArm === "default" ? quotient : safeResult
            }
          }),
          operandWrite(state.gpr("eax"), output)
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
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const block: IrBlock = {
    values,
    body: { nodes: [operandWrite(state.gpr("eax"), quotient)] }
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
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const wrapped = values.binary("add", quotient, values.const(1));
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: quotient,
        thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] }
      })]
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

test("both if arms share one wrapper captured after its trapping condition", async () => {
  const values = new ValueTable();
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const wrapped = values.binary("add", quotient, values.const(1));
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: quotient,
        thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] },
        elseBody: { nodes: [operandWrite(state.gpr("ebx"), wrapped)] }
      })]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);
  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  writeWasmCpuStateSnapshot(stateView, { eax: 7, ebx: 9 });
  strictEqual(run(84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 9);

  writeWasmCpuStateSnapshot(stateView, { eax: 7, ebx: 9 });
  strictEqual(run(0, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 1);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("captures after an unreachable structured operand still form valid Wasm", async () => {
  const values = new ValueTable();
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const unreachable = values.unreachable();
  const wrapped = values.unary("eqz", unreachable);
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: unreachable,
        thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] },
        elseBody: { nodes: [operandWrite(state.gpr("ebx"), wrapped)] }
      })]
    }
  };

  const { run } = await instantiateIrBlock(block);

  throws(() => run(), WebAssembly.RuntimeError);
});

test("switch arms share a wrapper captured after its trapping selector", async () => {
  const values = new ValueTable();
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const wrapped = values.binary("add", selector, values.const(1));
  const fallback = values.const(99);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            { matches: [0], body: { nodes: [], result: wrapped } },
            { matches: [1], body: { nodes: [], result: wrapped } }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        operandWrite(state.gpr("eax"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);
  const divideIndex = opcodes.indexOf(wasmOpcode.i32DivU);
  const addIndex = opcodes.indexOf(wasmOpcode.i32Add);
  const dispatchIndex = opcodes.indexOf(wasmOpcode.brTable);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Add).length, 1);
  strictEqual(divideIndex < addIndex && addIndex < dispatchIndex, true);

  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(run(0, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 1);
  strictEqual(run(2, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 2);
  strictEqual(run(10, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 99);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("an exported trapping value evaluates at the fragment boundary", async () => {
  const values = new ValueTable();
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const quotient = values.binary("div_u", values.external(0), values.external(1));
  const block: IrBlock = {
    values,
    body: { nodes: [operandWrite(state.gpr("eax"), values.const(5))] }
  };
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new WasmLocalScratchAllocator(body);
  const resultLocal = scratch.allocLocal(wasmValueType.i32);

  emitActionFragment(block, {
    body,
    scratch,
    bindings: createModuleBindings({
      functionDefinitions: new Map(),
      types: new Map(),
      tables: new Map(),
      resources: new Map([
        [cpuState.resource, wasmMemoryIndex.cpuState]
      ])
    }),
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
