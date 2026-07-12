import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createWasmCpuStateSnapshot, readWasmCpuState } from "#test/support/cpu-state.js";
import { WASM_CPU_STATE_BYTE_LENGTH, WASM_CPU_STATE_OFFSETS } from "#wasm/cpu-state-layout.js";
import { createWasmHostMemories, wasmPagesForByteLength } from "#wasm/host/memories.js";
import { MACHINE_FIXED_END, MACHINE_FIXED_PAGE_COUNT } from "#wasm/machine-state-layout.js";

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
    lazyFlagsA: 44,
    lazyFlagsB: 48,
    CF: 52,
    PF: 53,
    AF: 54,
    ZF: 55,
    SF: 56,
    OF: 57,
    DF: 58,
    TF: 59,
    NT: 60,
    AC: 61,
    ID: 62,
    esSelector: 64,
    csSelector: 66,
    ssSelector: 68,
    dsSelector: 70,
    fsSelector: 72,
    gsSelector: 74,
    esBase: 76,
    csBase: 80,
    ssBase: 84,
    dsBase: 88,
    fsBase: 92,
    gsBase: 96,
    esLimit: 100,
    csLimit: 104,
    ssLimit: 108,
    dsLimit: 112,
    fsLimit: 116,
    gsLimit: 120,
    esAccess: 124,
    csAccess: 128,
    ssAccess: 132,
    dsAccess: 136,
    fsAccess: 140,
    gsAccess: 144
  });
  strictEqual(WASM_CPU_STATE_BYTE_LENGTH, 148);
});

test("runtime Wasm memories expose the three live memory identities", () => {
  const memories = createWasmHostMemories();
  strictEqual(memories.cpuState.memory, memories.cpuStateMemory);
  strictEqual(memories.machine.memory, memories.machineMemory);
  strictEqual(memories.guestMemory instanceof WebAssembly.Memory, true);
  strictEqual("guest" in memories, false);
});

test("runtime Wasm memories expose a fixed-prefix machine memory and typed accessor", () => {
  const memories = createWasmHostMemories();

  strictEqual(memories.machineMemory.buffer.byteLength, MACHINE_FIXED_END);
  strictEqual(memories.machine.memory, memories.machineMemory);
});

test("runtime Wasm memories accept larger supplied machine memory without changing its bytes", () => {
  const machineMemory = new WebAssembly.Memory({ initial: MACHINE_FIXED_PAGE_COUNT + 1 });
  const bytes = new Uint8Array(machineMemory.buffer);

  bytes[0x1000] = 0x11;
  bytes[MACHINE_FIXED_END - 1] = 0x22;
  bytes[MACHINE_FIXED_END] = 0x33;

  const memories = createWasmHostMemories({ machineMemory });

  strictEqual(memories.machineMemory, machineMemory);
  strictEqual(memories.machine.memory, machineMemory);
  strictEqual(bytes[0x1000], 0x11);
  strictEqual(bytes[MACHINE_FIXED_END - 1], 0x22);
  strictEqual(bytes[MACHINE_FIXED_END], 0x33);
});

test("runtime Wasm memories reject supplied machine memory shorter than the fixed prefix", () => {
  const machineMemory = new WebAssembly.Memory({ initial: MACHINE_FIXED_PAGE_COUNT - 1 });

  throws(
    () => createWasmHostMemories({ machineMemory }),
    new RegExp(`machine memory is too small: .* < ${MACHINE_FIXED_END}`)
  );
});
