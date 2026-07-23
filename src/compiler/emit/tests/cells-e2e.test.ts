import { strictEqual } from "node:assert";
import { test } from "node:test";

import { cpuStateAccess } from "#test/support/execution-model.js";
import { gprChannel } from "#core/state/channels.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateChannel
} from "#test/support/cpu-state.js";
import {
  completedTestFunction,
  instantiateTestFunction,
  testFunctionCompleted
} from "./harness.js";

// Observable emitted-Wasm behavior for placement-owned cell storage.
test("cell reads and writes execute through placement-owned storage", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const cell = fn.region.cell(fn.values.const(37));
    const output = fn.region.read(cell);

    state.write(state.gpr("eax"), output);
  });
  const { run, stateView } = await instantiateTestFunction(fixture);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 37);
});

test("a cell read producer can realize in a nested body", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    const condition = fn.parameters[0]!;
    const cell = fn.region.cell(fn.values.const(1));

    fn.region.write(cell, fn.values.const(9));
    const output = fn.region.read(cell);

    fn.region.if(condition, (then) => {
      const state = cpuStateAccess.bind(then);

      state.write(state.gpr("eax"), output);
    });
  });
  const { run, stateView } = await instantiateTestFunction(fixture);

  strictEqual(run(1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
});

test("branch arms start from the incoming cell snapshot and join the selected write", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const condition = fn.parameters[0]!;
    const cell = fn.region.cell(fn.values.const(11));

    fn.region.if(
      condition,
      (then) => then.write(cell, fn.values.const(22)),
      {
        elseBuild: (otherwise) => {
          const incoming = otherwise.read(cell);
          const branchState = cpuStateAccess.bind(otherwise);

          branchState.write(branchState.gpr("ebx"), incoming);
        }
      }
    );
    const joined = fn.region.read(cell);

    state.write(state.gpr("eax"), joined);
  });
  const { run, stateView } = await instantiateTestFunction(fixture);

  writeWasmCpuStateChannel(stateView, gprChannel("ebx"), 99);
  strictEqual(run(0), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 11);

  writeWasmCpuStateChannel(stateView, gprChannel("ebx"), 99);
  strictEqual(run(1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 22);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 99);
});

test("an i64 cell local preserves its value through i32 truncation", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const cell = fn.region.cell(fn.values.const64(1n));

    fn.region.write(cell, fn.values.const64(0x1234_5678_89ab_cdefn));
    const wide = fn.region.read(cell);
    const low = fn.values.truncate64(32, wide);

    state.write(state.gpr("eax"), low);
  });
  const { run, stateView } = await instantiateTestFunction(fixture);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("eax")),
    0x89ab_cdef
  );
});
