import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#core/state/channels.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import {
  memoryReadOperation,
  operandRead,
  operandWrite
} from "#test/support/storage-operations.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  completedTestFunction,
  instantiateTestFunction,
  testFunctionCompleted
} from "./harness.js";

test("a single nested-body demand executes inside the selected body", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const values = fn.values;

    values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const loaded = values.addNodeOutput();

    fn.region.push(memoryReadOperation(loaded, fn.parameters[1]!, 32));
    fn.region.if(fn.parameters[0]!, (then) => {
      then.push(operandWrite(state.gpr("eax"), loaded));
    });
  });
  const { guestView, stateView, run } = await instantiateTestFunction(fixture);

  guestView.setUint32(0x100, 0x1234_5678, true);
  strictEqual(run(0, guestView.byteLength), testFunctionCompleted);
  strictEqual(run(1, 0x100), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 0x1234_5678);
  throws(() => run(1, guestView.byteLength), WebAssembly.RuntimeError);
});

test("an unused memory read is omitted without a placement", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    const address = fn.values.const(0xffff_fffc);
    const loaded = fn.values.addNodeOutput();

    fn.region.push(memoryReadOperation(loaded, address, 32));
  });

  const { run } = await instantiateTestFunction(fixture);

  strictEqual(run(), testFunctionCompleted);
});

test("a condition value remains available in its selected body", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const condition = fn.values.addNodeOutput();

    fn.region.push(operandRead(condition, state.gpr("eax")));
    fn.region.if(condition, (then) => {
      then.push(operandWrite(state.gpr("ebx"), condition));
    });
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 1, ebx: 0 });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 1);
});

test("an i32 control header preserves a pending i64 capture", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const values = fn.values;

    values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const wide = values.binary64(
      "mul",
      values.extend64(32, fn.parameters[1]!, false),
      values.const64(0x1_0000_0001n)
    );
    const low = values.truncate64(32, wide);
    const high = values.truncate64(
      32,
      values.binary64("shr_u", wide, values.const64(32n))
    );
    fn.region.if(fn.parameters[0]!, (then) => {
      then.push(operandWrite(state.gpr("eax"), low));
    }, {
      elseBuild: (otherwise) => {
        otherwise.push(operandWrite(state.gpr("ebx"), high));
      }
    });
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ebx: 0 });
  strictEqual(run(1, 7), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 0);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ebx: 0 });
  strictEqual(run(0, 7), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 0);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 7);
});

test("a trapping producer input still evaluates before a selected early exit", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    const values = fn.values;

    values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const index = values.binary("div_u", values.const(1), fn.parameters[1]!);
    const source = state.dynamicGpr(index, 32);
    const output = values.addNodeOutput();
    const exitResult = values.const64(0n);
    fn.region.push(operandRead(output, source));
    fn.region.if(fn.parameters[0]!, (then) => {
      then.return([exitResult]);
    });
    fn.region.push(operandWrite(state.gpr("eax"), output));
  });
  const { run } = await instantiateTestFunction(fixture);

  throws(() => run(1, 0), WebAssembly.RuntimeError);
});

test("an output local preserves a read snapshot across an overlapping write", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const snapshot = fn.values.addNodeOutput();
    const replacement = fn.values.const(5);

    fn.region.extend([
      operandRead(snapshot, state.gpr("eax")),
      operandWrite(state.gpr("eax"), replacement),
      operandWrite(state.gpr("ebx"), snapshot)
    ]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 41, ebx: 0 });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 41);
});

test("sibling bodies preserve their independent values", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const first = fn.values.addNodeOutput();
    const second = fn.values.addNodeOutput();

    fn.region.if(fn.parameters[0]!, (then) => {
      then.extend([
        operandRead(first, state.gpr("eax")),
        operandWrite(state.gpr("ebx"), first)
      ]);
    });
    fn.region.if(fn.parameters[1]!, (then) => {
      then.extend([
        operandRead(second, state.gpr("ecx")),
        operandWrite(state.gpr("edx"), second)
      ]);
    });
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11, ebx: 0, ecx: 0x22, edx: 0 });
  strictEqual(run(1, 1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 0x11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x22);
});

test("an output shared by sibling bodies keeps its value", async () => {
  const fixture = completedTestFunction(2, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const snapshot = fn.values.addNodeOutput();
    const interloper = fn.values.addNodeOutput();

    fn.region.push(operandRead(snapshot, state.gpr("eax")));
    fn.region.if(fn.parameters[0]!, (then) => {
      then.push(operandWrite(state.gpr("ebx"), snapshot));
    });
    fn.region.extend([
      operandRead(interloper, state.gpr("ecx")),
      operandWrite(state.gpr("edx"), interloper)
    ]);
    fn.region.if(fn.parameters[1]!, (then) => {
      then.push(operandWrite(state.gpr("esi"), snapshot));
    });
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x41, ebx: 0, ecx: 0x99, edx: 0, esi: 0 });
  strictEqual(run(0, 1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x99);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x41);
});

test("a dead nested producer is not evaluated", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const base = fn.values.addNodeOutput();
    const deadLoad = fn.values.addNodeOutput();

    fn.region.extend([
      operandRead(base, state.gpr("eax")),
      operandWrite(state.gpr("ebx"), base)
    ]);
    fn.region.if(fn.parameters[0]!, (then) => {
      then.push(memoryReadOperation(deadLoad, base, 32));
    });
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xffff_fffc,
    ebx: 0
  });
  strictEqual(run(1), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("ebx")),
    0xffff_fffc
  );
});
