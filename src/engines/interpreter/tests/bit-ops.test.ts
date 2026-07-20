import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  assertLazyFlagState,
  createWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf
} from "#test/support/cpu-state.js";
import { readPageFaultStop } from "#cpu/tests/stop-fixtures.js";
import { startAddress } from "#test/support/addresses.js";
import { assertCompletedInstruction, assertSingleInstructionExit, executeInstruction } from "./harness.js";

const preservedBitFlags = { CF: 1, PF: 0, AF: 1, ZF: 0, SF: 1, OF: 0 } as const;

test("executes register BT/BTS/BTR/BTC forms and preserves non-CF flags", async () => {
  const cases = [
    {
      name: "bt",
      bytes: [0x0f, 0xa3, 0xc8],
      eax: 0x20,
      ecx: 37,
      expectedEax: 0x20,
      expectedCf: 1
    },
    {
      name: "bts",
      bytes: [0x0f, 0xab, 0xc8],
      eax: 0,
      ecx: 33,
      expectedEax: 2,
      expectedCf: 0
    },
    {
      name: "btr",
      bytes: [0x0f, 0xb3, 0xc8],
      eax: 2,
      ecx: 33,
      expectedEax: 0,
      expectedCf: 1
    },
    {
      name: "btc",
      bytes: [0x0f, 0xbb, 0xc8],
      eax: 0,
      ecx: 33,
      expectedEax: 2,
      expectedCf: 0
    }
  ] as const;

  for (const entry of cases) {
    const initialState = createWasmCpuStateSnapshot({
      eax: entry.eax,
      ecx: entry.ecx,
      ...preservedBitFlags,
      eip: startAddress,
      instructionCount: 7
    });

    const { exit, state } = await executeInstruction(entry.bytes, initialState);

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, entry.expectedEax, entry.name);
    strictEqual(state.ecx, initialState.ecx, entry.name);
    assertCompletedInstruction(state, startAddress + entry.bytes.length, 8);
    deepStrictEqual(
      wasmCpuStatusFlagsOf(state),
      { ...preservedBitFlags, CF: entry.expectedCf },
      entry.name
    );
    assertLazyFlagState(state, { kind: "NONE", width: 0 }, entry.name);
  }
});

test("executes memory bit operations with immediate and negative register offsets", async () => {
  const immediate = await executeInstruction(
    [0x0f, 0xba, 0x2d, 0x20, 0x00, 0x00, 0x00, 36],
    createWasmCpuStateSnapshot({
      ...preservedBitFlags,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x20, bytes: [0, 0, 0, 0] }]
  );
  const negativeOffset = await executeInstruction(
    [0x0f, 0xbb, 0x08],
    createWasmCpuStateSnapshot({
      eax: 0x24,
      ecx: 0xffff_ffff,
      ...preservedBitFlags,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x20, bytes: [0, 0, 0, 0] }]
  );

  assertSingleInstructionExit(immediate.exit);
  strictEqual(immediate.guestView.getUint32(0x20, true), 0x10);
  assertCompletedInstruction(immediate.state, startAddress + 8, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(immediate.state), { ...preservedBitFlags, CF: 0 });

  assertSingleInstructionExit(negativeOffset.exit);
  strictEqual(negativeOffset.guestView.getUint32(0x20, true), 0x8000_0000);
  strictEqual(negativeOffset.guestView.getUint32(0x24, true), 0);
  assertCompletedInstruction(negativeOffset.state, startAddress + 3, 8);
  deepStrictEqual(wasmCpuStatusFlagsOf(negativeOffset.state), { ...preservedBitFlags, CF: 0 });
});

test("memory bit-string register offsets fault at the adjusted address", async () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ecx: 0xffff_ffe0,
    ...preservedBitFlags,
    eip: startAddress,
    instructionCount: 7
  });

  const { exit, state } = await executeInstruction([0x0f, 0xa3, 0x08], initialState);

  deepStrictEqual(exit, readPageFaultStop(0xffff_fffc));
  strictEqual(state.eax, initialState.eax);
  strictEqual(state.ecx, initialState.ecx);
  assertCompletedInstruction(state, startAddress, 7);
  deepStrictEqual(wasmCpuStatusFlagsOf(state), wasmCpuStatusFlagsOf(initialState));
});

test("executes BSF/BSR with hardware-probed undefined flag values", async () => {
  const cases = [
    {
      name: "bsf32 nonzero",
      bytes: [0x0f, 0xbc, 0xc3],
      eax: 0xaaaa_5555,
      ebx: 0x100,
      expectedEax: 8,
      expectedFlags: scanFlags(8, 0)
    },
    {
      name: "bsf32 zero",
      bytes: [0x0f, 0xbc, 0xc3],
      eax: 0xaaaa_5555,
      ebx: 0,
      expectedEax: 0xaaaa_5555,
      expectedFlags: scanFlags(0, 1)
    },
    {
      name: "bsr16 nonzero",
      bytes: [0x66, 0x0f, 0xbd, 0xc3],
      eax: 0xaaaa_0000,
      ebx: 0x20,
      expectedEax: 0xaaaa_0005,
      expectedFlags: scanFlags(5, 0)
    },
    {
      name: "bsr16 zero",
      bytes: [0x66, 0x0f, 0xbd, 0xc3],
      eax: 0xaaaa_1234,
      ebx: 0,
      expectedEax: 0xaaaa_1234,
      expectedFlags: scanFlags(0, 1)
    }
  ] as const;

  for (const entry of cases) {
    const { exit, state } = await executeInstruction(
      entry.bytes,
      createWasmCpuStateSnapshot({
        eax: entry.eax,
        ebx: entry.ebx,
        CF: 1,
        PF: 1,
        AF: 1,
        ZF: 0,
        SF: 1,
        OF: 1,
        eip: startAddress,
        instructionCount: 7
      })
    );

    assertSingleInstructionExit(exit);
    strictEqual(state.eax, entry.expectedEax, entry.name);
    strictEqual(state.ebx, entry.ebx, entry.name);
    assertCompletedInstruction(state, startAddress + entry.bytes.length, 8);
    deepStrictEqual(wasmCpuStatusFlagsOf(state), entry.expectedFlags, entry.name);
    assertLazyFlagState(state, { kind: "NONE", width: 0 }, entry.name);
  }
});

function scanFlags(indexForParity: number, zf: 0 | 1): Readonly<Record<"CF" | "PF" | "AF" | "ZF" | "SF" | "OF", number>> {
  return {
    CF: 0,
    PF: evenParity(indexForParity & 0xff) ? 1 : 0,
    AF: 0,
    ZF: zf,
    SF: 0,
    OF: 0
  };
}

function evenParity(value: number): boolean {
  let remaining = value & 0xff;
  let parity = 0;

  while (remaining !== 0) {
    parity ^= remaining & 1;
    remaining >>>= 1;
  }

  return parity === 0;
}
