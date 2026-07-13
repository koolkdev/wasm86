import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import type { RunStop } from "#cpu/cpu.js";
import { createMachine } from "#machine/machine.js";

const startAddress = 0x1000;

test("Cpu calls its interpreter once with unchanged fuel and propagates its exception", () => {
  const realWasmInstance = WebAssembly.Instance;
  const expected = new WebAssembly.RuntimeError("interpreter trap");
  const fuels: number[] = [];

  Object.defineProperty(WebAssembly, "Instance", {
    configurable: true,
    value: function MockWasmInstance() {
      return {
        exports: {
          run(fuel: number): bigint {
            fuels.push(fuel);
            throw expected;
          }
        }
      };
    }
  });

  try {
    const cpu = createMachine({ memoryByteLength: 0x1000 }).cpu;

    throws(
      () => cpu.run({ instructionBudget: 0xffff_ffff }),
      (error: unknown) => error === expected
    );
    deepStrictEqual(fuels, [0xffff_ffff]);
  } finally {
    Object.defineProperty(WebAssembly, "Instance", {
      configurable: true,
      value: realWasmInstance
    });
  }
});

test("Cpu propagates entry decoder exceptions", () => {
  const realWasmInstance = WebAssembly.Instance;

  Object.defineProperty(WebAssembly, "Instance", {
    configurable: true,
    value: function MockWasmInstance() {
      return {
        exports: {
          run(): bigint {
            return 0n;
          }
        }
      };
    }
  });

  try {
    const cpu = createMachine({ memoryByteLength: 0x1000 }).cpu;

    throws(
      () => cpu.run({ instructionBudget: 1 }),
      /unknown Wasm exit family/
    );
  } finally {
    Object.defineProperty(WebAssembly, "Instance", {
      configurable: true,
      value: realWasmInstance
    });
  }
});

test("RunStop excludes the Runtime-only transfer sentinel", () => {
  // @ts-expect-error Runtime's legacy transfer sentinel is not a Cpu stop.
  const invalidStop: RunStop = { kind: "none" };

  void invalidStop;
});

test("Cpu exhausts fuel and resumes only on a later explicit run", () => {
  const machine = createMachine({ memoryByteLength: 0x2000 });
  const bytes = new Uint8Array(machine.memory.buffer);

  bytes.set([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00, // mov ecx, 2
    0xcd, 0x2e                    // int 0x2e
  ], startAddress);
  machine.cpu.state.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.eip, startAddress + 5);
  strictEqual(machine.cpu.state.instructionCount, 1);
  strictEqual(machine.cpu.state.readReg32("eax"), 1);
  strictEqual(machine.cpu.state.readReg32("ecx"), 0);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 2 }), {
    kind: "hostTrap",
    vector: 0x2e
  });
  strictEqual(machine.cpu.state.eip, startAddress + 12);
  strictEqual(machine.cpu.state.instructionCount, 3);
  strictEqual(machine.cpu.state.readReg32("ecx"), 2);
});

test("Cpu reports an interpreter CPU exception from its bound state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const boundary = machine.memory.buffer.byteLength;

  machine.cpu.state.eip = boundary;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: pageFault(boundary, PageFaultErrorCode.INSTRUCTION_FETCH)
  });
  strictEqual(machine.cpu.state.eip, boundary);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu accepts zero fuel without entering an instruction", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  machine.cpu.state.eip = startAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 0 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu rejects invalid fuel before calling the interpreter", () => {
  const cpu = createMachine({ memoryByteLength: 0x1000 }).cpu;

  cpu.state.eip = startAddress;

  for (const instructionBudget of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x1_0000_0000
  ]) {
    throws(
      () => cpu.run({ instructionBudget }),
      /instructionBudget must be a valid Wasm i32 fuel value/
    );
  }

  strictEqual(cpu.state.eip, startAddress);
  strictEqual(cpu.state.instructionCount, 0);
});
