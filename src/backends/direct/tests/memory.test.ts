import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { StopReason, type FaultOperation } from "#x86/execution/run-result.js";
import { ArrayBufferGuestMemory, type MemoryFault } from "#x86/memory/guest-memory.js";
import { fillGuestMemory, readGuestBytes, writeGuestU32 } from "#x86/memory/tests/helpers.js";
import { cloneCpuState, createCpuState, getFlag } from "#x86/state/cpu-state.js";
import { bytes, runIsaBytes, startAddress } from "./helpers.js";

test("loads and stores absolute u32 memory", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, eip: startAddress });
  const result = run(state, [
    0x89, 0x05, 0x20, 0x00, 0x00, 0x00,
    0x8b, 0x1d, 0x20, 0x00, 0x00, 0x00
  ], memory);

  strictEqual(result.stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), [0x78, 0x56, 0x34, 0x12]);
  strictEqual(state.ebx, 0x1234_5678);
  strictEqual(state.instructionCount, 2);
});

test("loads memory using base displacement", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebx: 0x20, eip: startAddress });

  memory.writeU32(0x24, 0x89ab_cdef);
  run(state, [0x8b, 0x43, 0x04], memory);

  strictEqual(state.eax, 0x89ab_cdef);
});

test("stores memory using ebp negative displacement", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, ebp: 0x30, eip: startAddress });

  run(state, [0x89, 0x45, 0xfc], memory);

  deepStrictEqual(readGuestBytes(memory, 0x2c, 4), [0x78, 0x56, 0x34, 0x12]);
});

test("stores imm32 memory using C7 group", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eip: startAddress });

  strictEqual(run(state, [0xc7, 0x05, 0x20, 0x00, 0x00, 0x00, 0x78, 0x56, 0x34, 0x12], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), [0x78, 0x56, 0x34, 0x12]);
});

test("loads and stores byte and word memory widths", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0xaabb_ccdd, ebx: 0x10, eip: startAddress });

  strictEqual(run(state, [0x88, 0x43, 0x04], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x14, 4), [0xdd, 0x00, 0x00, 0x00]);

  memory.writeU16(0x16, 0x1234);
  state.eax = 0xaabb_ccdd;
  state.eip = startAddress;

  strictEqual(run(state, [0x66, 0x8b, 0x43, 0x06], memory).stopReason, StopReason.NONE);
  strictEqual(state.eax, 0xaabb_1234);
});

test("memory load fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 });
  const before = cloneCpuState(state);
  const result = run(state, [0x8b, 0x05, 0x40, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x40);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, before.eax);
  strictEqual(state.eip, before.eip);
  strictEqual(state.instructionCount, before.instructionCount);
});

test("byte and word memory faults report access width", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const byteState = createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 });
  const wordState = createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 });

  const byteResult = run(byteState, [0x8a, 0x05, 0x40, 0x00, 0x00, 0x00], memory);
  const wordResult = run(wordState, [0x66, 0x8b, 0x05, 0x3f, 0x00, 0x00, 0x00], memory);

  strictEqual(byteResult.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(byteResult.faultAddress, 0x40);
  strictEqual(byteResult.faultSize, 1);
  strictEqual(byteResult.faultOperation, "read");
  strictEqual(byteState.instructionCount, 7);

  strictEqual(wordResult.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(wordResult.faultAddress, 0x3f);
  strictEqual(wordResult.faultSize, 2);
  strictEqual(wordResult.faultOperation, "read");
  strictEqual(wordState.instructionCount, 7);
});

test("memory store fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, eip: startAddress, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0x89, 0x05, 0x3e, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "write");
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("wrapped effective address faults", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x1234_5678, ebx: 0, eip: startAddress, instructionCount: 7 });
  const before = cloneCpuState(state);
  const result = run(state, [0x8b, 0x43, 0xff], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0xffff_ffff);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, before.eax);
  strictEqual(state.eip, before.eip);
  strictEqual(state.instructionCount, before.instructionCount);
});

test("add loads memory operand like register operand", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const memoryState = createCpuState({ eax: 0xffff_ffff, eip: startAddress });
  const registerState = createCpuState({ eax: 0xffff_ffff, ebx: 1, eip: startAddress });

  writeGuestU32(memory, 0x20, 1);

  strictEqual(run(memoryState, [0x03, 0x05, 0x20, 0x00, 0x00, 0x00], memory).stopReason, StopReason.NONE);
  strictEqual(run(registerState, [0x03, 0xc3]).stopReason, StopReason.NONE);
  strictEqual(memoryState.eax, registerState.eax);
  strictEqual(memoryState.eflags, registerState.eflags);
});

test("add stores memory destination", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x20, ebx: 2, eip: startAddress });

  writeGuestU32(memory, 0x20, 1);

  strictEqual(run(state, [0x01, 0x18], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), [0x03, 0x00, 0x00, 0x00]);
});

test("or and and support memory operands", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x20, ebx: 0xf0, eip: startAddress });

  writeGuestU32(memory, 0x20, 0x0f);

  strictEqual(run(state, [0x09, 0x18], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), [0xff, 0x00, 0x00, 0x00]);

  state.eip = startAddress;
  strictEqual(run(state, [0x23, 0x18], memory).stopReason, StopReason.NONE);
  strictEqual(state.ebx, 0xf0);
  strictEqual(getFlag(state, "ZF"), false);
});

test("cmp memory does not write memory", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 5, eip: startAddress });

  writeGuestU32(memory, 0x20, 5);

  const beforeBytes = readGuestBytes(memory, 0x20, 4);

  strictEqual(run(state, [0x39, 0x05, 0x20, 0x00, 0x00, 0x00], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), beforeBytes);
  strictEqual(getFlag(state, "ZF"), true);
});

test("test memory does not write memory", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0x0f, eip: startAddress });

  writeGuestU32(memory, 0x20, 0xf0);

  const beforeBytes = readGuestBytes(memory, 0x20, 4);

  strictEqual(run(state, [0x85, 0x05, 0x20, 0x00, 0x00, 0x00], memory).stopReason, StopReason.NONE);
  deepStrictEqual(readGuestBytes(memory, 0x20, 4), beforeBytes);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("memory ALU fault before write is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 5, eip: startAddress, eflags: 0x8d5, instructionCount: 7 });

  fillGuestMemory(memory, 0xaa);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0x01, 0x05, 0x3e, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.eflags, beforeState.eflags);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("memory ALU write guard faults before flags mutate", () => {
  const memory = new WriteFaultGuestMemory(0x40, 0x20);
  const state = createCpuState({ eax: 5, eip: startAddress, eflags: 0x8d5, instructionCount: 7 });

  writeGuestU32(memory, 0x20, 1);

  const beforeState = cloneCpuState(state);
  const beforeBytes = readGuestBytes(memory, 0, memory.byteLength);
  const result = run(state, [0x01, 0x05, 0x20, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x20);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "write");
  strictEqual(state.eax, beforeState.eax);
  strictEqual(state.eflags, beforeState.eflags);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
  deepStrictEqual(readGuestBytes(memory, 0, memory.byteLength), beforeBytes);
});

test("memory cmp fault does not update flags", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 1, eip: startAddress, eflags: 0x8d5, instructionCount: 7 });
  const beforeState = cloneCpuState(state);
  const result = run(state, [0x3b, 0x05, 0x3e, 0x00, 0x00, 0x00], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x3e);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eflags, beforeState.eflags);
  strictEqual(state.eip, beforeState.eip);
  strictEqual(state.instructionCount, beforeState.instructionCount);
});

function run(state: ReturnType<typeof createCpuState>, values: readonly number[], memory?: ArrayBufferGuestMemory) {
  return runIsaBytes(state, bytes(values), {
    baseAddress: startAddress,
    ...(memory === undefined ? {} : { memory })
  });
}

class WriteFaultGuestMemory extends ArrayBufferGuestMemory {
  constructor(byteLength: number, readonly faultAddress: number) {
    super(byteLength);
  }

  override checkAccess(address: number, byteLength: number, operation: FaultOperation): MemoryFault | undefined {
    if (operation === "write" && address === this.faultAddress) {
      return { faultAddress: address, faultSize: byteLength, faultOperation: operation };
    }

    return super.checkAccess(address, byteLength, operation);
  }
}
