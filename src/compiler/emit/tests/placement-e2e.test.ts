import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#core/state/channels.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import {
  memoryReadOperation,
  operandRead,
  operandWrite
} from "#test/support/storage-operations.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  wasmBodyInstructions,
  wasmBodyLocalCount,
  wasmBodyOpcodes
} from "#compiler/encoder/tests/body-opcodes.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  completedTestFunction,
  instantiateTestFunction,
  testFunctionBody,
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
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);
  const loadIndex = opcodes.indexOf(wasmOpcode.i32Load);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(loadIndex > ifIndex, true);
  const { guestView, run } = await instantiateTestFunction(fixture);

  guestView.setUint32(0x100, 0x1234_5678, true);
  strictEqual(run(0, 0x100), testFunctionCompleted);
  strictEqual(run(1, 0x100), testFunctionCompleted);
});

test("a selected-body producer keeps its compound input in the body", () => {
  const fixture = completedTestFunction(2, (fn) => {
    const values = fn.values;

    values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const address = values.binary("add", fn.parameters[1]!, values.const(4));
    const loaded = values.addNodeOutput();

    fn.region.push(memoryReadOperation(loaded, address, 32));
    fn.region.if(fn.parameters[0]!, (then) => {
      then.push(operandWrite(state.gpr("eax"), loaded));
    });
  });
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(opcodes.indexOf(wasmOpcode.i32Add) > ifIndex, true);
  strictEqual(opcodes.indexOf(wasmOpcode.i32Load) > ifIndex, true);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(opcodes.includes(wasmOpcode.localTee), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a producer declared inside a body executes only on that selected body", async () => {
  const fixture = completedTestFunction(1, (fn) => {
    const values = fn.values;

    values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const address = values.const(0x100);
    const loaded = values.addNodeOutput();

    fn.region.if(fn.parameters[0]!, (then) => {
      then.extend([
        memoryReadOperation(loaded, address, 32),
        operandWrite(state.gpr("eax"), loaded)
      ]);
    });
  });
  const { guestView, stateView, run } = await instantiateTestFunction(fixture);

  guestView.setUint32(0x100, 0x1234_5678, true);
  strictEqual(run(0), testFunctionCompleted);
  strictEqual(run(1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 0x1234_5678);
});

test("an unused memory read is omitted without a placement", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    const address = fn.values.const(0x100);
    const loaded = fn.values.addNodeOutput();

    fn.region.push(memoryReadOperation(loaded, address, 32));
  });
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.drop), false);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);

  const { run } = await instantiateTestFunction(fixture);

  strictEqual(run(), testFunctionCompleted);
});

test("an unused state read emits neither its opcode nor an output local", () => {
  const fixture = completedTestFunction(0, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const read = fn.values.addNodeOutput();

    fn.region.push(operandRead(read, state.gpr("eax")));
  });
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.drop), false);
  strictEqual(opcodes.includes(wasmOpcode.localSet), false);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a live single-use output materializes directly at its use", () => {
  const fixture = completedTestFunction(0, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const read = fn.values.addNodeOutput();

    fn.region.extend([
      operandRead(read, state.gpr("eax")),
      operandWrite(state.gpr("ebx"), read)
    ]);
  });
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localSet).length, 0);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localGet).length, 0);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a condition use tees once for a later selected-body use", async () => {
  const fixture = completedTestFunction(0, (fn) => {
    fn.values.const(0);
    const state = cpuStateAccess.bind(fn.region);
    const condition = fn.values.addNodeOutput();

    fn.region.push(operandRead(condition, state.gpr("eax")));
    fn.region.if(condition, (then) => {
      then.push(operandWrite(state.gpr("ebx"), condition));
    });
  });
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localTee).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.localSet).length, 0);

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
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);
  const multiplyIndex = opcodes.indexOf(wasmOpcode.i64Mul);
  const captureIndex = opcodes.indexOf(wasmOpcode.localSet);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(wasmBodyLocalCount(encoded) > 0, true);
  strictEqual(multiplyIndex < captureIndex && captureIndex < ifIndex, true);

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
  const opcodes = wasmBodyOpcodes(testFunctionBody(fixture));
  const divideIndex = opcodes.indexOf(wasmOpcode.i32DivU);
  const ifIndex = opcodes.indexOf(wasmOpcode.if);

  strictEqual(divideIndex >= 0 && divideIndex < ifIndex, true);

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

test("a long straight-line sequence materializes each output directly", () => {
  const fixture = completedTestFunction(0, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const outputCount = 64;

    fn.values.const(0);
    for (let index = 0; index < outputCount; index += 1) {
      const output = fn.values.addNodeOutput();

      fn.region.extend([
        operandRead(output, state.gpr("eax")),
        operandWrite(state.gpr("ebx"), output)
      ]);
    }
  });
  const encoded = testFunctionBody(fixture);
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
  const encoded = testFunctionBody(fixture);
  const outputSets = wasmBodyInstructions(encoded)
    .filter((instruction) => instruction.opcode === wasmOpcode.localSet)
    .map((instruction) => instruction.local);

  strictEqual(wasmBodyLocalCount(encoded), 0);
  deepStrictEqual(outputSets, []);

  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11, ebx: 0, ecx: 0x22, edx: 0 });
  strictEqual(run(1, 1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 0x11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x22);
});

test("an output used by both siblings cannot recycle between them", async () => {
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
  const encoded = testFunctionBody(fixture);
  const localInstructions = wasmBodyInstructions(encoded)
    .filter((instruction) => instruction.local !== undefined)
    .map((instruction) => [instruction.opcode, instruction.local] as const);

  strictEqual(wasmBodyLocalCount(encoded), 1);
  deepStrictEqual(localInstructions, [
    [wasmOpcode.localGet, 0],
    [wasmOpcode.localSet, 2],
    [wasmOpcode.localGet, 2],
    [wasmOpcode.localGet, 1],
    [wasmOpcode.localGet, 2]
  ]);

  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x41, ebx: 0, ecx: 0x99, edx: 0, esi: 0 });
  strictEqual(run(0, 1), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 0x99);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x41);
});

test("dead nested producers do not recapture an already consumed output", () => {
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
  const encoded = testFunctionBody(fixture);
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Load).length, 1);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});
