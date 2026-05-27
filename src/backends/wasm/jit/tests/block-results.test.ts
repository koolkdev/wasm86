import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#wasm/exit.js";
import { createCpuState } from "#x86/state/cpu-state.js";
import { startAddress } from "./block-test-helpers.js";
import { assertBlockResult } from "./block-result-helpers.js";

const preservedEflags = 0x0020_0000;
const CF = 0x001;
const PF = 0x004;
const AF = 0x010;
const ZF = 0x040;
const SF = 0x080;
const OF = 0x800;
const hostTrap = [0xcd, 0x2e] as const;

test("block preserves alias reads", async () => {
  const snapshot = await assertBlockResult("alias reads", {
    bytes: [
      0x88, 0xc3, // mov bl, al
      0x88, 0xe1, // mov cl, ah
      0x66, 0x89, 0xc2, // mov dx, ax
      0x89, 0xc6 // mov esi, eax
    ],
    initialState: createCpuState({
      eax: 0x1234_5678,
      ebx: 0xaaaa_aa00,
      ecx: 0xbbbb_bb00,
      edx: 0xcccc_0000,
      esi: 0,
      eflags: preservedEflags,
      eip: startAddress
    })
  });

  strictEqual(snapshot.state.ebx, 0xaaaa_aa78);
  strictEqual(snapshot.state.ecx, 0xbbbb_bb56);
  strictEqual(snapshot.state.edx, 0xcccc_5678);
  strictEqual(snapshot.state.esi, 0x1234_5678);
  strictEqual(snapshot.state.eflags, preservedEflags);
  deepStrictEqual(snapshot.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 9 });
});

test("block preserves partial and full register writes", async () => {
  const cases = [
    {
      name: "AL write preserves AH and high word",
      bytes: [0xb0, 0x44],
      eax: 0x1122_3300,
      expectedEax: 0x1122_3344
    },
    {
      name: "AH write preserves AL and high word",
      bytes: [0xb4, 0x55],
      eax: 0x1122_0033,
      expectedEax: 0x1122_5533
    },
    {
      name: "AX write preserves high word",
      bytes: [0x66, 0xb8, 0x78, 0x56],
      eax: 0x1234_0000,
      expectedEax: 0x1234_5678
    },
    {
      name: "EAX write replaces the full register",
      bytes: [0xb8, 0xef, 0xcd, 0xab, 0x89],
      eax: 0x1122_3344,
      expectedEax: 0x89ab_cdef
    }
  ] as const;

  for (const entry of cases) {
    const snapshot = await assertBlockResult(entry.name, {
      bytes: entry.bytes,
      initialState: createCpuState({ eax: entry.eax, eflags: preservedEflags, eip: startAddress })
    });

    strictEqual(snapshot.state.eax, entry.expectedEax, entry.name);
    strictEqual(snapshot.state.eflags, preservedEflags, entry.name);
    deepStrictEqual(snapshot.exit, {
      exitReason: ExitReason.FALLTHROUGH,
      payload: startAddress + entry.bytes.length
    }, entry.name);
  }
});

test("block stores byte and word memory widths", async () => {
  const cases = [
    {
      name: "byte store writes only AL",
      bytes: [0x88, 0x03],
      expectedMemory: [0xdd, 0x22, 0x33, 0x44]
    },
    {
      name: "word store writes only AX",
      bytes: [0x66, 0x89, 0x03],
      expectedMemory: [0xdd, 0xcc, 0x33, 0x44]
    }
  ] as const;

  for (const entry of cases) {
    const snapshot = await assertBlockResult(entry.name, {
      bytes: entry.bytes,
      initialState: createCpuState({
        eax: 0xaabb_ccdd,
        ebx: 0x40,
        eflags: preservedEflags,
        eip: startAddress
      }),
      memory: [{ address: 0x40, bytes: [0x11, 0x22, 0x33, 0x44] }],
      watchMemory: [{ address: 0x40, byteLength: 4 }]
    });

    deepStrictEqual(snapshot.memory, [{ address: 0x40, bytes: entry.expectedMemory }], entry.name);
    strictEqual(snapshot.state.eax, 0xaabb_ccdd, entry.name);
    strictEqual(snapshot.state.ebx, 0x40, entry.name);
  }
});

test("block snapshots alias-clobbering exits after reading sources", async () => {
  const registerSwap = await assertBlockResult("xchg register exit stores", {
    bytes: [
      0x87, 0xd8, // xchg eax, ebx
      ...hostTrap
    ],
    initialState: createCpuState({
      eax: 0x1111_1111,
      ebx: 0x2222_2222,
      eflags: preservedEflags,
      eip: startAddress
    })
  });
  const aliasSwap = await assertBlockResult("xchg alias exit stores", {
    bytes: [
      0x86, 0xe0, // xchg al, ah
      ...hostTrap
    ],
    initialState: createCpuState({
      eax: 0x1234_5678,
      eflags: preservedEflags,
      eip: startAddress
    })
  });

  strictEqual(registerSwap.state.eax, 0x2222_2222);
  strictEqual(registerSwap.state.ebx, 0x1111_1111);
  deepStrictEqual(registerSwap.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(aliasSwap.state.eax, 0x1234_7856);
  strictEqual(aliasSwap.state.eflags, preservedEflags);
  deepStrictEqual(aliasSwap.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("block snapshots memory read faults before uncommitted writeback", async () => {
  const snapshot = await assertBlockResult("xchg memory read fault", {
    bytes: [0x87, 0x18], // xchg [eax], ebx
    initialState: createCpuState({
      eax: 0x1_0000,
      ebx: 0x2222_2222,
      eflags: preservedEflags,
      eip: startAddress,
      instructionCount: 7
    })
  });

  strictEqual(snapshot.state.eax, 0x1_0000);
  strictEqual(snapshot.state.ebx, 0x2222_2222);
  strictEqual(snapshot.state.eflags, preservedEflags);
  strictEqual(snapshot.state.eip, startAddress);
  strictEqual(snapshot.state.instructionCount, 7);
  deepStrictEqual(snapshot.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
});

test("block updates arithmetic and logic flags", async () => {
  const cases = [
    {
      name: "ADD AL sign overflow uses bit 7",
      bytes: [0x04, 0x01],
      initial: createCpuState({ eax: 0x7f, eflags: preservedEflags, eip: startAddress }),
      expected: { eax: 0x80, eflags: preservedEflags | OF | SF | AF }
    },
    {
      name: "ADD AX sign overflow uses bit 15",
      bytes: [0x66, 0x05, 0x01, 0x00],
      initial: createCpuState({ eax: 0x7fff, eflags: preservedEflags, eip: startAddress }),
      expected: { eax: 0x8000, eflags: preservedEflags | OF | SF | AF | PF }
    },
    {
      name: "SUB EAX borrow wraps and preserves result width",
      bytes: [0x2d, 0x01, 0x00, 0x00, 0x00],
      initial: createCpuState({ eax: 0, eflags: preservedEflags, eip: startAddress }),
      expected: { eax: 0xffff_ffff, eflags: preservedEflags | CF | PF | AF | SF }
    },
    {
      name: "CMP writes flags without writing operands",
      bytes: [0x39, 0xd8],
      initial: createCpuState({ eax: 5, ebx: 5, eflags: preservedEflags, eip: startAddress }),
      expected: { eax: 5, ebx: 5, eflags: preservedEflags | PF | ZF }
    },
    {
      name: "TEST parity observes only the low byte",
      bytes: [0x85, 0xd8],
      initial: createCpuState({ eax: 0x100, ebx: 0x100, eflags: preservedEflags | CF | OF | AF, eip: startAddress }),
      expected: { eax: 0x100, ebx: 0x100, eflags: preservedEflags | PF }
    }
  ] as const;

  for (const entry of cases) {
    const snapshot = await assertBlockResult(entry.name, {
      bytes: entry.bytes,
      initialState: entry.initial
    });

    strictEqual(snapshot.state.eax, entry.expected.eax, entry.name);
    if ("ebx" in entry.expected) {
      strictEqual(snapshot.state.ebx, entry.expected.ebx, entry.name);
    }
    strictEqual(snapshot.state.eflags, entry.expected.eflags, entry.name);
    strictEqual(snapshot.state.arithmeticEflags, entry.expected.eflags & 0x8d5, entry.name);
  }
});

test("block reads conditions after partial flag writes", async () => {
  const carrySet = await assertBlockResult("INC preserves incoming CF for SETB", {
    bytes: [
      0x40, // inc eax
      0x0f, 0x92, 0xc3 // setb bl
    ],
    initialState: createCpuState({
      eax: 0xffff_ffff,
      ebx: 0xaaaa_aa00,
      eflags: preservedEflags | CF,
      eip: startAddress
    })
  });
  const carryClear = await assertBlockResult("DEC preserves clear incoming CF for SETB", {
    bytes: [
      0x48, // dec eax
      0x0f, 0x92, 0xc3 // setb bl
    ],
    initialState: createCpuState({
      eax: 0,
      ebx: 0xaaaa_aa00,
      eflags: preservedEflags,
      eip: startAddress
    })
  });

  strictEqual(carrySet.state.eax, 0);
  strictEqual(carrySet.state.ebx, 0xaaaa_aa01);
  strictEqual(carrySet.state.eflags, preservedEflags | CF | PF | AF | ZF);

  strictEqual(carryClear.state.eax, 0xffff_ffff);
  strictEqual(carryClear.state.ebx, 0xaaaa_aa00);
  strictEqual(carryClear.state.eflags, preservedEflags | PF | AF | SF);
});

test("block result helper rejects instruction-byte memory watches", async () => {
  await rejects(
    assertBlockResult("instruction-byte watch", {
      bytes: [0xb8, 0x78, 0x56, 0x34, 0x12],
      initialState: createCpuState({ eip: startAddress }),
      watchMemory: [{ address: startAddress + 1, byteLength: 2 }]
    }),
    /block memory watches must not overlap instruction bytes/
  );
});
