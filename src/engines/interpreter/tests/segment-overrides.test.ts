import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createWasmCpuStateSnapshot,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";
import { startAddress } from "#test/support/addresses.js";
import {
  assertCompletedInstruction,
  assertSingleInstructionExit,
  executeInstruction,
  type ExecutedInstruction,
  type GuestMemoryBytes
} from "./support.js";

test("FS override on a ModRM memory load reads through the FS base", async () => {
  const result = await executeInstruction(
    [0x64, 0x8b, 0x03],
    state({ ebx: 0x20, fsBase: 0x1000 }),
    [{ address: 0x1020, bytes: dwordBytes(0x1234_5678) }]
  );

  assertSingleInstructionExit(result.exit);
  strictEqual(result.state.eax, 0x1234_5678);
  assertCompletedInstruction(result.state, startAddress + 3, 8);
});

test("GS override on a moffs store writes at base plus offset", async () => {
  const result = await executeInstruction(
    [0x65, 0xa3, 0x30, 0x00, 0x00, 0x00],
    state({ eax: 0xcafe_babe, gsBase: 0x2000 })
  );

  assertSingleInstructionExit(result.exit);
  strictEqual(result.guestView.getUint32(0x2030, true), 0xcafe_babe);
  assertCompletedInstruction(result.state, startAddress + 6, 8);
});

test("FS override on a no-base ModRM disp32 load adds the FS base", async () => {
  const result = await executeInstruction(
    [0x64, 0x8b, 0x05, 0x30, 0x00, 0x00, 0x00],
    state({ fsBase: 0x1000 }),
    [{ address: 0x1030, bytes: dwordBytes(0xfeed_face) }]
  );

  assertSingleInstructionExit(result.exit);
  strictEqual(result.state.eax, 0xfeed_face);
  assertCompletedInstruction(result.state, startAddress + 7, 8);
});

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

test("unprefixed no-base ModRM and moffs memory loads default to DS", async () => {
  const disp32Load = await executeInstruction(
    [0x8b, 0x05, 0x30, 0x00, 0x00, 0x00],
    state({ dsBase: 0x1000, ssBase: 0x3000 }),
    [
      { address: 0x1030, bytes: dwordBytes(0x5555_5555) },
      { address: 0x3030, bytes: dwordBytes(0x6666_6666) }
    ]
  );
  const moffsLoad = await executeInstruction(
    [0xa1, 0x40, 0x00, 0x00, 0x00],
    state({ dsBase: 0x1000, ssBase: 0x3000 }),
    [
      { address: 0x1040, bytes: dwordBytes(0x7777_7777) },
      { address: 0x3040, bytes: dwordBytes(0x8888_8888) }
    ]
  );

  assertSingleInstructionExit(disp32Load.exit);
  strictEqual(disp32Load.state.eax, 0x5555_5555);
  assertCompletedInstruction(disp32Load.state, startAddress + 6, 8);

  assertSingleInstructionExit(moffsLoad.exit);
  strictEqual(moffsLoad.state.eax, 0x7777_7777);
  assertCompletedInstruction(moffsLoad.state, startAddress + 5, 8);
});

test("DS override on an EBP based ModRM memory load overrides the SS default", async () => {
  const result = await executeInstruction(
    [0x3e, 0x8b, 0x45, 0x00],
    state({ ebp: 0x20, dsBase: 0x1000, ssBase: 0x3000 }),
    [
      { address: 0x1020, bytes: dwordBytes(0x9999_9999) },
      { address: 0x3020, bytes: dwordBytes(0xaaaa_aaaa) }
    ]
  );

  assertSingleInstructionExit(result.exit);
  strictEqual(result.state.eax, 0x9999_9999);
  assertCompletedInstruction(result.state, startAddress + 4, 8);
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
