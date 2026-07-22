import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { ifControl, switchControl } from "#compiler/ir/controls/index.js";
import { gprChannel } from "#core/state/channels.js";
import { operandWrite } from "#ir/tests/storage-op-helpers.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import {
  completedTestFunction,
  instantiateTestFunction,
  testFunction,
  testFunctionBody,
  testFunctionCompleted
} from "./harness.js";

test("a trapping value used only by a future then body stays in that body", async () => {
  const fixture = completedTestFunction(3, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[1]!,
      fn.parameters[2]!
    );

    fn.region.extend([ifControl.create({
      condition: fn.parameters[0]!,
      thenBody: { nodes: [operandWrite(state.gpr("eax"), quotient)] }
    })]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  strictEqual(run(0, 1, 0), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
  strictEqual(run(1, 84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});

test("a transitively trapping wrapper used only by a future body stays in that body", async () => {
  const fixture = completedTestFunction(3, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[1]!,
      fn.parameters[2]!
    );
    const wrapped = fn.values.binary("add", quotient, fn.values.const(1));

    fn.region.extend([ifControl.create({
      condition: fn.parameters[0]!,
      thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] }
    })]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  strictEqual(run(0, 1, 0), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
  strictEqual(run(1, 84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});

test("trapping switch arm results evaluate only when selected", async () => {
  for (const trappingArm of ["case", "default"] as const) {
    const fixture = completedTestFunction(3, (fn) => {
      const state = cpuStateAccess.bind(fn.region);
      const quotient = fn.values.binary(
        "div_u",
        fn.parameters[1]!,
        fn.parameters[2]!
      );
      const safeResult = fn.values.const(7);
      const output = fn.values.addNodeOutput();

      fn.region.extend([
        switchControl.create({
          selector: fn.parameters[0]!,
          output,
          cases: [{
            matches: [0],
            body: {
              nodes: [],
              result: trappingArm === "case" ? quotient : safeResult
            }
          }],
          defaultBody: {
            nodes: [],
            result: trappingArm === "default" ? quotient : safeResult
          }
        }),
        operandWrite(state.gpr("eax"), output)
      ]);
    });
    const { stateView, run } = await instantiateTestFunction(fixture);
    const safeSelector = trappingArm === "case" ? 1 : 0;
    const trappingSelector = trappingArm === "case" ? 0 : 1;

    strictEqual(run(safeSelector, 1, 0), testFunctionCompleted, trappingArm);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7, trappingArm);
    strictEqual(run(trappingSelector, 84, 2), testFunctionCompleted, trappingArm);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42, trappingArm);
    throws(() => run(trappingSelector, 1, 0), WebAssembly.RuntimeError, trappingArm);
  }
});

test("a trapping value demanded directly by the current body still evaluates", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[0]!,
      fn.parameters[1]!
    );

    fn.region.extend([operandWrite(state.gpr("eax"), quotient)]);
  });
  const opcodes = wasmBodyOpcodes(testFunctionBody(fixture));
  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(run(84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("a trapping condition makes its selected wrapper safe to capture", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[0]!,
      fn.parameters[1]!
    );
    const wrapped = fn.values.binary("add", quotient, fn.values.const(1));

    fn.region.extend([ifControl.create({
      condition: quotient,
      thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] }
    })]);
  });
  const opcodes = wasmBodyOpcodes(testFunctionBody(fixture));
  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(run(84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);

  writeWasmCpuStateSnapshot(stateView, { eax: 7 });
  strictEqual(run(0, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("both if arms share one wrapper captured after its trapping condition", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[0]!,
      fn.parameters[1]!
    );
    const wrapped = fn.values.binary("add", quotient, fn.values.const(1));

    fn.region.extend([ifControl.create({
      condition: quotient,
      thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] },
      elseBody: { nodes: [operandWrite(state.gpr("ebx"), wrapped)] }
    })]);
  });
  const opcodes = wasmBodyOpcodes(testFunctionBody(fixture));
  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  writeWasmCpuStateSnapshot(stateView, { eax: 7, ebx: 9 });
  strictEqual(run(84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 43);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 9);

  writeWasmCpuStateSnapshot(stateView, { eax: 7, ebx: 9 });
  strictEqual(run(0, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 1);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("captures after an unreachable structured operand still form valid Wasm", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const unreachable = fn.values.unreachable();
    const wrapped = fn.values.unary("eqz", unreachable);

    fn.region.extend([ifControl.create({
      condition: unreachable,
      thenBody: { nodes: [operandWrite(state.gpr("eax"), wrapped)] },
      elseBody: { nodes: [operandWrite(state.gpr("ebx"), wrapped)] }
    })]);
  });
  const { run } = await instantiateTestFunction(fixture);

  throws(() => run(), WebAssembly.RuntimeError);
});

test("switch arms share a wrapper captured after its trapping selector", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const selector = fn.values.binary(
      "div_u",
      fn.parameters[0]!,
      fn.parameters[1]!
    );
    const wrapped = fn.values.binary("add", selector, fn.values.const(1));
    const fallback = fn.values.const(99);
    const output = fn.values.addNodeOutput();

    fn.region.extend([
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
    ]);
  });
  const opcodes = wasmBodyOpcodes(testFunctionBody(fixture));
  const divideIndex = opcodes.indexOf(wasmOpcode.i32DivU);
  const addIndex = opcodes.indexOf(wasmOpcode.i32Add);
  const dispatchIndex = opcodes.indexOf(wasmOpcode.brTable);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32DivU).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Add).length, 1);
  strictEqual(divideIndex < addIndex && addIndex < dispatchIndex, true);

  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(run(0, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 1);
  strictEqual(run(2, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 2);
  strictEqual(run(10, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 99);
  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("a trapping function result evaluates after preceding effects", async () => {
  const fixture = testFunction(2, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const quotient = fn.values.binary(
      "div_u",
      fn.parameters[0]!,
      fn.parameters[1]!
    );

    fn.region.extend([operandWrite(state.gpr("eax"), fn.values.const(5))]);
    fn.return([fn.values.extend64(32, quotient, false)]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(run(84, 2), 42n);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);

  writeWasmCpuStateSnapshot(stateView, { eax: 9 });
  throws(() => run(1, 0), WebAssembly.RuntimeError);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
});
