import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createMachine } from "#machine/machine.js";
import { startAddress } from "#test/support/addresses.js";

test("Cpu exhausts its instruction budget and resumes only on a later explicit run", () => {
  const machine = createMachine({ memoryByteLength: 0x2000 });
  const bytes = new Uint8Array(machine.memory.buffer);

  bytes.set([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00, // mov ecx, 2
    0xcd, 0x2e                    // int 0x2e
  ], startAddress);
  machine.cpu.state.core.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.core.eip, startAddress + 5);
  strictEqual(machine.cpu.state.instructionCount, 1);
  strictEqual(machine.cpu.state.core.readReg32("eax"), 1);
  strictEqual(machine.cpu.state.core.readReg32("ecx"), 0);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 2 }), {
    kind: "hostTrap",
    vector: 0x2e
  });
  strictEqual(machine.cpu.state.core.eip, startAddress + 12);
  strictEqual(machine.cpu.state.instructionCount, 3);
  strictEqual(machine.cpu.state.core.readReg32("ecx"), 2);
});

test("Cpu reports an interpreter CPU exception from its bound state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const boundary = machine.memory.buffer.byteLength;

  machine.cpu.state.core.eip = boundary;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: { kind: "PF", linearAddress: boundary, errorCode: 16 }
  });
  strictEqual(machine.cpu.state.core.eip, boundary);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu accepts a zero instruction budget without entering an instruction", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  machine.cpu.state.core.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 0 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.core.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu rejects budgets outside the supported modular deadline range", () => {
  const cpu = createMachine({ memoryByteLength: 0x1000 }).cpu;

  cpu.state.core.eip = startAddress;

  for (const instructionBudget of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x8000_0000,
    0xffff_ffff,
    0x1_0000_0000
  ]) {
    throws(
      () => cpu.run({ instructionBudget }),
      /instructionBudget must be an integer in the supported modular deadline range/
    );
  }

  strictEqual(cpu.state.core.eip, startAddress);
  strictEqual(cpu.state.instructionCount, 0);
});
