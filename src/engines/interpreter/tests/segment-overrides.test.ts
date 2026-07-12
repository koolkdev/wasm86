import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  type ExecutedInstruction,
  type GuestMemoryBytes
} from "./support.js";

test("unprefixed EBP and ESP based ModRM memory loads default to SS", async () => {
  const ebpLoad = await executeInstruction(
    [0x8b, 0x45, 0x00],
    state({ ebp: 0x20, dsBase: 0x1000, ssBase: 0x3000 }),
    [
      { address: 0x1020, bytes: dwordBytes(0x1111_1111) },
      { address: 0x3020, bytes: dwordBytes(0x2222_2222) }
    ]
  );
  const espLoad = await executeInstruction(
    [0x8b, 0x04, 0x24],
    state({ esp: 0x30, dsBase: 0x1000, ssBase: 0x3000 }),
    [
      { address: 0x1030, bytes: dwordBytes(0x3333_3333) },
      { address: 0x3030, bytes: dwordBytes(0x4444_4444) }
    ]
  );

  assertSingleInstructionExit(ebpLoad.exit);
  strictEqual(ebpLoad.state.eax, 0x2222_2222);
  assertCompletedInstruction(ebpLoad.state, startAddress + 3, 8);

  assertSingleInstructionExit(espLoad.exit);
  strictEqual(espLoad.state.eax, 0x4444_4444);
  assertCompletedInstruction(espLoad.state, startAddress + 3, 8);
});

test("segment and operand-size overrides execute in either order", async () => {
  const memory: readonly GuestMemoryBytes[] = [{ address: 0x1020, bytes: wordBytes(0x1234) }];
  const initial = state({ eax: 0xffff_0000, ebx: 0x20, fsBase: 0x1000 });
  const segmentFirst = await executeInstruction([0x64, 0x66, 0x8b, 0x03], initial, memory);
  const operandSizeFirst = await executeInstruction([0x66, 0x64, 0x8b, 0x03], initial, memory);

  assertWordLoad(segmentFirst);
  assertWordLoad(operandSizeFirst);
  deepStrictEqual(operandSizeFirst.state, segmentFirst.state);
});

test("repeated segment overrides use the last segment prefix", async () => {
  const result = await executeInstruction(
    [0x64, 0x65, 0x8b, 0x03],
    state({ ebx: 0x20, fsBase: 0x1000, gsBase: 0x2000 }),
    [
      { address: 0x1020, bytes: dwordBytes(0x1111_1111) },
      { address: 0x2020, bytes: dwordBytes(0x2222_2222) }
    ]
  );

  assertSingleInstructionExit(result.exit);
  strictEqual(result.state.eax, 0x2222_2222);
  assertCompletedInstruction(result.state, startAddress + 4, 8);
});

function assertWordLoad(result: ExecutedInstruction): void {
  assertSingleInstructionExit(result.exit);
  strictEqual(result.state.eax, 0xffff_1234);
  assertCompletedInstruction(result.state, startAddress + 4, 8);
}

function state(overrides: WasmCpuStateInit) {
  return createWasmCpuStateSnapshot({
    eip: startAddress,
    instructionCount: 7,
    ...overrides
  });
}

function wordBytes(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function dwordBytes(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ];
}
