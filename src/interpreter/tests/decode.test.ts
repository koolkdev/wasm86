import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  executeInstruction,
  instantiateInterpreter,
  writeGuestBytes
} from "./harness.js";

test("the generated decoder binds opcode registers including a high-byte alias", () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1122_3344,
    eip: startAddress,
    instructionCount: 7
  });
  const edi = executeInstruction(
    [0xbf, 0x01, 0x00, 0x00, 0x00],
    initialState
  );

  deepStrictEqual(edi.exit, { kind: "instructionLimit" });
  strictEqual(edi.state.edi, 1);
  strictEqual(edi.state.eax, initialState.eax);
  strictEqual(edi.state.eip, startAddress + 5);
  strictEqual(edi.state.instructionCount, 8);

  const highByte = executeInstruction([0xb4, 0x12], initialState);

  deepStrictEqual(highByte.exit, { kind: "instructionLimit" });
  strictEqual(highByte.state.eax, 0x1122_1244);
  strictEqual(highByte.state.eip, startAddress + 2);
  strictEqual(highByte.state.instructionCount, 8);
});

test("the generated decoder binds ModRM and grouped register forms", () => {
  const cases = [
    {
      name: "8B binds ModRM.reg as the destination",
      bytes: [0x8b, 0xc3],
      initial: { eax: 0, ebx: 0x1234_5678 },
      expectedEax: 0x1234_5678
    },
    {
      name: "C7 selects the /0 register form",
      bytes: [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12],
      initial: { eax: 0, ebx: 0 },
      expectedEax: 0x1234_5678
    },
    {
      name: "88 binds high-byte ModRM registers",
      bytes: [0x88, 0xcc],
      initial: { eax: 0x1122_3344, ecx: 0xaaaa_aa5a },
      expectedEax: 0x1122_5a44
    },
    {
      name: "8C binds a segment-register source",
      bytes: [0x8c, 0xe0],
      initial: { eax: 0xffff_ffff, fsSelector: 0x2468 },
      expectedEax: 0x2468
    }
  ] as const;

  for (const entry of cases) {
    const { exit, state } = executeInstruction(
      entry.bytes,
      createWasmCpuStateSnapshot({
        ...entry.initial,
        eip: startAddress,
        instructionCount: 7
      })
    );

    deepStrictEqual(exit, { kind: "instructionLimit" }, entry.name);
    strictEqual(state.eax, entry.expectedEax, entry.name);
    strictEqual(state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(state.instructionCount, 8, entry.name);
  }
});

test("the generated decoder binds a SIB index, scale, and displacement", () => {
  const { exit, state } = executeInstruction(
    [0x8b, 0x04, 0x8d, 0x20, 0x00, 0x00, 0x00],
    createWasmCpuStateSnapshot({
      ecx: 2,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x28, bytes: [0xef, 0xbe, 0xad, 0xde] }]
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 0xdead_beef);
  strictEqual(state.ecx, 2);
  strictEqual(state.eip, startAddress + 7);
  strictEqual(state.instructionCount, 8);
});

test("a dynamic ESP base is read after POP increments the stack pointer", () => {
  const popped = 0x1234_5678;
  const { exit, state, guestView } = executeInstruction(
    [0x8f, 0x04, 0x24],
    createWasmCpuStateSnapshot({
      esp: 0x100,
      eip: startAddress,
      instructionCount: 7
    }),
    [{
      address: 0x100,
      bytes: [0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0]
    }]
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.esp, 0x104);
  strictEqual(state.eip, startAddress + 3);
  strictEqual(state.instructionCount, 8);
  strictEqual(guestView.getUint32(0x100, true), popped);
  strictEqual(guestView.getUint32(0x104, true), popped);
});

test("the generated decoder binds a segment-register destination", () => {
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_1357,
    dsSelector: 0x3333,
    eip: startAddress,
    instructionCount: 7
  });
  const { exit, state } = executeInstruction([0x8e, 0xd8], initialState);

  deepStrictEqual(exit, {
    kind: "segmentLoad",
    segment: "ds",
    selector: 0x1357
  });
  deepStrictEqual(state, initialState);
});

test("the generated decoder composes repeated operand-size prefixes", () => {
  const { exit, state } = executeInstruction(
    [0x66, 0x66, 0xb8, 0x34, 0x12],
    createWasmCpuStateSnapshot({
      eax: 0xffff_0000,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 0xffff_1234);
  strictEqual(state.eip, startAddress + 5);
  strictEqual(state.instructionCount, 8);
});

test("the generated decoder dispatches a valid two-byte opcode", () => {
  const { exit, state } = executeInstruction(
    [0x0f, 0xc8],
    createWasmCpuStateSnapshot({
      eax: 0x1234_5678,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eax, 0x7856_3412);
  strictEqual(state.eip, startAddress + 2);
  strictEqual(state.instructionCount, 8);
});

test("a segment override changes a string source but not its fixed ES destination", () => {
  const { exit, state, guestView } = executeInstruction(
    [0x64, 0xa4],
    createWasmCpuStateSnapshot({
      esi: 0x20,
      edi: 0x30,
      fsBase: 0x100,
      eip: startAddress,
      instructionCount: 7
    }),
    [{ address: 0x120, bytes: [0xa5] }]
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(guestView.getUint8(0x30), 0xa5);
  strictEqual(guestView.getUint8(0x130), 0);
  strictEqual(state.esi, 0x21);
  strictEqual(state.edi, 0x31);
  strictEqual(state.eip, startAddress + 2);
  strictEqual(state.instructionCount, 8);
});

test("the generated decoder selects the zero-trip REP form", () => {
  const { exit, state } = executeInstruction(
    [0xf3, 0xa5],
    createWasmCpuStateSnapshot({
      ecx: 0,
      esi: guestMemoryMinimumByteLength,
      edi: guestMemoryMinimumByteLength,
      eip: startAddress,
      instructionCount: 7
    })
  );

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(state.eip, startAddress + 2);
  strictEqual(state.instructionCount, 8);
});

test("the generated decoder rejects unsupported opcode and prefix paths", () => {
  for (const bytes of [
    [0x62],
    [0x0f, 0x0b],
    [0xf3, 0x90]
  ] as const) {
    const initialState = createWasmCpuStateSnapshot({
      eax: 0x1122_3344,
      eip: startAddress,
      instructionCount: 7
    });
    const { exit, state } = executeInstruction(bytes, initialState);

    deepStrictEqual(exit, {
      kind: "cpuException",
      exception: { kind: "UD" }
    });
    deepStrictEqual(state, initialState);
  }
});

test("an invalid ModRM group is decisive before its address tail", () => {
  const eip = guestMemoryMinimumByteLength - 2;
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    eip,
    instructionCount: 7
  });
  const { exit, state } = executeInstruction(
    [0xf7, 0x0d],
    initialState
  );

  deepStrictEqual(exit, {
    kind: "cpuException",
    exception: { kind: "UD" }
  });
  deepStrictEqual(state, initialState);
});

test("truncated decoder fields fault at the first unavailable byte", () => {
  const boundary = guestMemoryMinimumByteLength;
  const cases = [
    {
      name: "two-byte opcode",
      eip: boundary - 1,
      bytes: [0x0f]
    },
    {
      name: "ModRM",
      eip: boundary - 1,
      bytes: [0x8b]
    },
    {
      name: "SIB",
      eip: boundary - 2,
      bytes: [0x8b, 0x04]
    },
    {
      name: "immediate",
      eip: boundary - 2,
      bytes: [0xb8, 0x99]
    },
    {
      name: "displacement",
      eip: boundary - 5,
      bytes: [0x8b, 0x05, 0x00, 0x20, 0x00]
    }
  ] as const;

  for (const entry of cases) {
    const interpreter = instantiateInterpreter();
    const initialState = createWasmCpuStateSnapshot({
      eax: 0x1122_3344,
      eip: entry.eip,
      instructionCount: 7
    });

    writeWasmCpuStateSnapshot(interpreter.stateView, initialState);
    writeGuestBytes(interpreter.guestView, entry.eip, entry.bytes);

    deepStrictEqual(interpreter.runFor(1), {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: boundary,
        errorCode: 16
      }
    }, entry.name);
    deepStrictEqual(
      readWasmCpuStateSnapshot(interpreter.stateView),
      initialState,
      entry.name
    );
  }
});
