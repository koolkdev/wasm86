import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, readWasmCpuState } from "#runtime/tests/fixtures/cpu-state.js";
import { WASM_CPU_STATE_BYTE_LENGTH, WASM_CPU_STATE_OFFSETS } from "#wasm/cpu-state-layout.js";
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

test("runtime Wasm memories expose raw cpu state field offsets", () => {
  deepStrictEqual(WASM_CPU_STATE_OFFSETS, {
    eax: 0,
    ecx: 4,
    edx: 8,
    ebx: 12,
    esp: 16,
    ebp: 20,
    esi: 24,
    edi: 28,
    eip: 32,
    instructionCount: 36,
    lazyFlagsKind: 40,
    CF: 41,
    PF: 42,
    AF: 43,
    ZF: 44,
    SF: 45,
    OF: 46,
    DF: 47,
    TF: 48,
    NT: 49,
    AC: 50,
    ID: 51,
    lazyFlagsA: 52,
    lazyFlagsB: 56
  });
  strictEqual(WASM_CPU_STATE_BYTE_LENGTH, 60);
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
