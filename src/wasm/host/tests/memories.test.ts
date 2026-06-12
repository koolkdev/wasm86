import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState } from "#x86/state/cpu-state.js";
import { stateByteLength, stateOffset } from "#wasm/abi.js";
import { createWasmHostMemories, wasmPagesForByteLength } from "#wasm/host/memories.js";

test("wasmPagesForByteLength rounds up to WebAssembly pages", () => {
  strictEqual(wasmPagesForByteLength(0), 1);
  strictEqual(wasmPagesForByteLength(1), 1);
  strictEqual(wasmPagesForByteLength(0x1_0000), 1);
  strictEqual(wasmPagesForByteLength(0x1_0001), 2);
});

test("runtime Wasm memories expose canonical state memory", () => {
  const memories = createWasmHostMemories();

  memories.state.load({ eax: 0x1234_5678, eip: 0x401000, instructionCount: 7 });
  memories.state.write("ebx", 0xaabb_ccdd);
  memories.state.eflags = 0xffff_08d5;

  const snapshot = memories.state.snapshot();

  deepStrictEqual(snapshot, createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaabb_ccdd,
    eflags: 0xffff_08d5,
    eip: 0x401000,
    instructionCount: 7
  }));
  strictEqual(memories.state.eflags, 0xffff_08d5);
  strictEqual(snapshot.eflags, 0xffff_08d5);
});

test("runtime Wasm state layout exposes raw execution fields", () => {
  deepStrictEqual(stateOffset, {
    eax: 0,
    ecx: 4,
    edx: 8,
    ebx: 12,
    esp: 16,
    ebp: 20,
    esi: 24,
    edi: 28,
    eip: 32,
    ctrlFlags: 36,
    instructionCount: 40,
    stopReason: 44
  });
  strictEqual(stateByteLength, 54);
});

test("runtime Wasm guest memory reads writes and reports faults", () => {
  const memories = createWasmHostMemories({ guestMemoryByteLength: 0x20 });

  strictEqual(memories.guest.writeU32(0x10, 0x1234_5678).ok, true);
  deepStrictEqual(memories.guest.readU32(0x10), { ok: true, value: 0x1234_5678 });
  deepStrictEqual(memories.guest.writeU32(memories.guest.byteLength - 2, 0), {
    ok: false,
    fault: {
      faultAddress: memories.guest.byteLength - 2,
      faultSize: 4,
      faultOperation: "write"
    }
  });
});
