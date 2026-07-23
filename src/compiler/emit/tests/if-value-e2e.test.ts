import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#core/state/channels.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  completedTestFunction,
  instantiateTestFunction,
  testFunctionCompleted
} from "./harness.js";

// Observable emitted-Wasm behavior for value-producing branches.
test("ifValue selects one arm result", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const output = fn.region.ifValue(
      fn.parameters[0]!,
      (then) => {
        const branchState = cpuStateAccess.bind(then);

        return branchState.read(branchState.gpr("ebx"));
      },
      (otherwise) => {
        const branchState = cpuStateAccess.bind(otherwise);

        return branchState.read(branchState.gpr("ecx"));
      },
      { hint: "unlikely" }
    );

    state.write(state.gpr("eax"), output);
  });

  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { ebx: 11, ecx: 22 });
  strictEqual(run(1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(run(0), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 22);
});

test("a dead ifValue output preserves an impossible selected arm", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    fn.region.ifValue(
      fn.parameters[0]!,
      (then) => then.values.const(7),
      (otherwise) => otherwise.values.unreachable()
    );
  });
  const { run } = await instantiateTestFunction(fixture);

  strictEqual(run(1), testFunctionCompleted);
  throws(() => run(0), WebAssembly.RuntimeError);
});

test("a shared unreachable result traps in either selected arm", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    fn.region.ifValue(
      fn.parameters[0]!,
      (then) => then.values.unreachable(),
      (otherwise) => otherwise.values.unreachable()
    );
  });
  const { run } = await instantiateTestFunction(fixture);

  throws(() => run(1), WebAssembly.RuntimeError);
  throws(() => run(0), WebAssembly.RuntimeError);
});

test("an unselected ifValue arm does not evaluate a trapping result", async () => {
  const fixture = completedTestFunction(3, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const output = fn.region.ifValue(
      fn.parameters[0]!,
      () => fn.values.binary("div_u", fn.parameters[1]!, fn.parameters[2]!),
      (otherwise) => otherwise.values.const(7)
    );

    state.write(state.gpr("eax"), output);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  strictEqual(run(0, 1, 0), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(run(1, 84, 2), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});
