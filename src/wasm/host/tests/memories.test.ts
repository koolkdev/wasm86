import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { executionStateLayout } from "#ir/state-layout.js";
import { createWasmCpuStateSnapshot, readWasmCpuState } from "#test/support/cpu-state.js";
import { createWasmHostMemories, wasmPagesForByteLength } from "#wasm/host/memories.js";

test("wasmPagesForByteLength rounds up to WebAssembly pages", () => {
  strictEqual(wasmPagesForByteLength(0), 1);
  strictEqual(wasmPagesForByteLength(1), 1);
  strictEqual(wasmPagesForByteLength(0x1_0000), 1);
  strictEqual(wasmPagesForByteLength(0x1_0001), 2);
});

test("runtime Wasm memories expose canonical cpu state memory", () => {
  const memories = createWasmHostMemories();

  memories.cpuState.load({ eax: 0x1234_5678, eip: 0x401000, instructionCount: 7, CF: 1, ZF: 1 });
  memories.cpuState.writeReg32("ebx", 0xaabb_ccdd);

  const snapshot = readWasmCpuState(memories.cpuState);

  deepStrictEqual(snapshot, createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: 0xaabb_ccdd,
    CF: 1,
    ZF: 1,
    eip: 0x401000,
    instructionCount: 7
  }));
});

test("runtime Wasm memories expose the live memory identities", () => {
  const memories = createWasmHostMemories();

  strictEqual(memories.cpuState.memory, memories.cpuStateMemory);
  strictEqual(memories.cpuStateMemory.buffer.byteLength >= executionStateLayout.byteLength, true);
  strictEqual(memories.guestMemory instanceof WebAssembly.Memory, true);
  strictEqual("guest" in memories, false);
});
