import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { StopReason } from "#x86/execution/run-result.js";
import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { cloneCpuState, createCpuState } from "#x86/state/cpu-state.js";
import { fillGuestMemory, readGuestBytes, writeGuestU32 } from "#x86/memory/tests/helpers.js";
import { bytes, runIsaBytes, startAddress } from "./helpers.js";

test("push pop roundtrips register", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, esp: 0x40, eip: startAddress });
  const result = run(state, [0x50, 0x5b], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.ebx, 0x1234_5678);
  strictEqual(state.esp, 0x40);
  strictEqual(state.instructionCount, 2);
});

test("push imm32 writes little endian value", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x40, eip: startAddress });
  const result = run(state, [0x68, 0x44, 0x33, 0x22, 0x11], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.esp, 0x3c);
  deepStrictEqual(readGuestBytes(memory, 0x3c, 4), [0x44, 0x33, 0x22, 0x11]);
});

test("push imm8 sign extends", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x40, eip: startAddress });
  const result = run(state, [0x6a, 0xff], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.esp, 0x3c);
  deepStrictEqual(readGuestBytes(memory, 0x3c, 4), [0xff, 0xff, 0xff, 0xff]);
});

test("pop oob fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, esp: 0x3e, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0x58], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("pop writes a memory destination", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebx: 0x20, esp: 0x38, eip: startAddress });

  writeGuestU32(memory, 0x38, 0x1122_3344);

  const result = run(state, [0x8f, 0x03], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.esp, 0x3c);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), [0x44, 0x33, 0x22, 0x11]);
  strictEqual(state.instructionCount, 1);
});

test("pop [esp] stores at the incremented esp", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x20, eip: startAddress });

  writeGuestU32(memory, 0x20, 0x1122_3344);

  const result = run(state, [0x8f, 0x04, 0x24], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.esp, 0x24);
  deepStrictEqual(readGuestBytes(memory, 0x24, 4), [0x44, 0x33, 0x22, 0x11]);
});

test("pop memory destination fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebx: 0x3e, esp: 0x20, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  // The destination write guard faults after the template already advanced
  // esp; the entry snapshot must roll it back.
  const result = run(state, [0x8f, 0x03], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "write");
  strictEqual(state.ebx, beforeState.ebx);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("leave restores caller frame", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebp: 0x20, esp: 0x38, eip: startAddress });

  writeGuestU32(memory, 0x20, 0x1234_5678);

  const result = run(state, [0xc9], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.ebp, 0x1234_5678);
  strictEqual(state.esp, 0x24);
  strictEqual(state.eip, startAddress + 1);
  strictEqual(state.instructionCount, 1);
});

test("leave pop fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, ebp: 0x3e, esp: 0x20, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0xc9], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.ebp, beforeState.ebp);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("push oob fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, esp: 0x42, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0x50], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "write");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("call ret returns to next instruction", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x40, eip: startAddress });
  const result = run(state, [
    0xe8, 0x02, 0x00, 0x00, 0x00,
    0xeb, 0x06,
    0xb8, 0x78, 0x56, 0x34, 0x12,
    0xc3
  ], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.esp, 0x40);
  strictEqual(state.eip, startAddress + 0x0d);
  strictEqual(state.instructionCount, 4);
});

test("ret imm cleans stack", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x20, eip: startAddress });
  const target = 0x2000;

  writeGuestU32(memory, 0x20, target);

  const result = run(state, [0xc2, 0x08, 0x00], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eip, target);
  strictEqual(state.esp, 0x2c);
  strictEqual(state.instructionCount, 1);
});

test("call pushes little endian return address", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ esp: 0x40, eip: startAddress });
  const result = run(state, [0xe8, 0x0b, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eip, startAddress + 0x10);
  strictEqual(state.esp, 0x3c);
  deepStrictEqual(readGuestBytes(memory, 0x3c, 4), [0x05, 0x10, 0x00, 0x00]);
});

test("ret oob fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, esp: 0x3e, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0xc3], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("call push oob fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, esp: 0x42, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0xe8, 0x0b, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "write");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.esp, beforeState.esp);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

function run(state: ReturnType<typeof createCpuState>, values: readonly number[], memory: ArrayBufferGuestMemory) {
  return runIsaBytes(state, bytes(values), {
    baseAddress: startAddress,
    memory
  });
}
