import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#backends/wasm/exit.js";
import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction
} from "./support.js";

const startAddress = 0x1000;

test("executes register-only XCHG forms after reading both operands", async () => {
  const flags = 0x8d5;
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    initial: CpuState;
    expected: Pick<CpuState, "eax" | "ebx" | "eflags">;
  }>[] = [
    {
      name: "xchg eax, ebx",
      bytes: [0x87, 0xd8],
      initial: createCpuState({ eax: 0x1111_1111, ebx: 0x2222_2222, eflags: flags, eip: startAddress }),
      expected: { eax: 0x2222_2222, ebx: 0x1111_1111, eflags: flags }
    },
    {
      name: "xchg al, bl",
      bytes: [0x86, 0xd8],
      initial: createCpuState({ eax: 0x1234_5678, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      expected: { eax: 0x1234_56dd, ebx: 0xaabb_cc78, eflags: flags }
    },
    {
      name: "xchg ax, bx",
      bytes: [0x66, 0x87, 0xd8],
      initial: createCpuState({ eax: 0x1234_5678, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      expected: { eax: 0x1234_ccdd, ebx: 0xaabb_5678, eflags: flags }
    },
    {
      name: "xchg al, ah",
      bytes: [0x86, 0xe0],
      initial: createCpuState({ eax: 0x1234_5678, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      expected: { eax: 0x1234_7856, ebx: 0xaabb_ccdd, eflags: flags }
    }
  ];

  for (const entry of cases) {
    const { exit, state } = await executeInstruction(entry.bytes, entry.initial);

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, entry.expected.eax, entry.name);
    strictEqual(state.ebx, entry.expected.ebx, entry.name);
    strictEqual(state.eflags, entry.expected.eflags, entry.name);
    assertCompletedInstruction(state, startAddress + entry.bytes.length, 1);
  }
});

test("executes same-register XCHG forms as flagless no-ops", async () => {
  const flags = 0x8d5;
  const cases: readonly Readonly<{ name: string; bytes: readonly number[] }>[] = [
    { name: "xchg eax, eax", bytes: [0x87, 0xc0] },
    { name: "xchg ax, ax", bytes: [0x66, 0x87, 0xc0] },
    { name: "xchg al, al", bytes: [0x86, 0xc0] },
    { name: "xchg ah, ah", bytes: [0x86, 0xe4] }
  ];

  for (const entry of cases) {
    const initial = createCpuState({ eax: 0x1234_5678, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress });
    const { exit, state } = await executeInstruction(entry.bytes, initial);

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, initial.eax, entry.name);
    strictEqual(state.ebx, initial.ebx, entry.name);
    strictEqual(state.eflags, flags, entry.name);
    assertCompletedInstruction(state, startAddress + entry.bytes.length, 1);
  }
});

test("executes memory XCHG forms after reading memory and register operands", async () => {
  const flags = 0x8d5;
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    initial: CpuState;
    memoryValue: number;
    expected: Pick<CpuState, "eax" | "ebx" | "eflags">;
    expectedMemoryValue: number;
  }>[] = [
    {
      name: "xchg [eax], ebx",
      bytes: [0x87, 0x18],
      width: 32,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      memoryValue: 0x1122_3344,
      expected: { eax: 0x20, ebx: 0x1122_3344, eflags: flags },
      expectedMemoryValue: 0xaabb_ccdd
    },
    {
      name: "xchg [eax], bl",
      bytes: [0x86, 0x18],
      width: 8,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      memoryValue: 0x78,
      expected: { eax: 0x20, ebx: 0xaabb_cc78, eflags: flags },
      expectedMemoryValue: 0xdd
    },
    {
      name: "xchg [eax], bx",
      bytes: [0x66, 0x87, 0x18],
      width: 16,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress }),
      memoryValue: 0x1357,
      expected: { eax: 0x20, ebx: 0xaabb_1357, eflags: flags },
      expectedMemoryValue: 0xccdd
    }
  ];

  for (const entry of cases) {
    const { exit, state, guestView } = await executeInstruction(
      entry.bytes,
      entry.initial,
      [{ address: entry.initial.eax, bytes: littleEndianBytes(entry.memoryValue, entry.width) }]
    );

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, entry.expected.eax, entry.name);
    strictEqual(state.ebx, entry.expected.ebx, entry.name);
    strictEqual(state.eflags, entry.expected.eflags, entry.name);
    strictEqual(readGuestValue(guestView, entry.initial.eax, entry.width), entry.expectedMemoryValue, entry.name);
    assertCompletedInstruction(state, startAddress + entry.bytes.length, 1);
  }
});

test("executes XCHG [ESP], ESP using the original memory address", async () => {
  const initial = createCpuState({
    esp: 0x20,
    eflags: 0x8d5,
    eip: startAddress
  });
  const { exit, state, guestView } = await executeInstruction(
    [0x87, 0x24, 0x24],
    initial,
    [{ address: initial.esp, bytes: littleEndianBytes(0x1122_3344, 32) }]
  );

  assertSingleInstructionExit(exit);
  strictEqual(state.esp, 0x1122_3344);
  strictEqual(state.eflags, initial.eflags);
  strictEqual(guestView.getUint32(initial.esp, true), initial.esp);
  assertCompletedInstruction(state, startAddress + 3, 1);
});

test("XCHG memory read faults before changing register state", async () => {
  const initial = createCpuState({
    eax: 0x1_0000,
    ebx: 0x2222_2222,
    eflags: 0x8d5,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = await executeInstruction([0x87, 0x18], initial);

  deepStrictEqual(exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
  strictEqual(state.eax, initial.eax);
  strictEqual(state.ebx, initial.ebx);
  strictEqual(state.eflags, initial.eflags);
  strictEqual(state.eip, initial.eip);
  strictEqual(state.instructionCount, initial.instructionCount);
});

function littleEndianBytes(value: number, width: 8 | 16 | 32): readonly number[] {
  const byteCount = width / 8;

  return Array.from({ length: byteCount }, (_, index) => (value >>> (index * 8)) & 0xff);
}

function readGuestValue(view: DataView, address: number, width: 8 | 16 | 32): number {
  switch (width) {
    case 8:
      return view.getUint8(address);
    case 16:
      return view.getUint16(address, true);
    case 32:
      return view.getUint32(address, true);
  }
}
