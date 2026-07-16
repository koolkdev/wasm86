import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  PageFaultErrorCode,
  divideError,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import { createMachine } from "#machine/machine.js";
import { startAddress } from "#test/support/addresses.js";
import {
  assertInstructionFixtureResult,
  prepareInstructionFixture
} from "#test/support/instruction-fixture.js";
import { CPU_PROGRAM_FIXTURES } from "#test/support/programs.js";

for (const fixture of CPU_PROGRAM_FIXTURES) {
  test(`Cpu executes ${fixture.name}`, () => {
    const machine = prepareInstructionFixture(fixture);
    const stop = machine.cpu.run({ instructionBudget: 100 });

    assertInstructionFixtureResult(fixture, stop, machine);
  });
}

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

test("Cpu propagates exit decoder exceptions", () => {
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
      /unknown cpu.exit variant tag: 0/
    );
  } finally {
    Object.defineProperty(WebAssembly, "Instance", {
      configurable: true,
      value: realWasmInstance
    });
  }
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

test("Cpu fetches any in-bounds guest bytes regardless of which range the caller wrote", () => {
  const machine = createMachine({ memoryByteLength: 0x2000 });
  const writtenProgramAddress = 0x1000;
  const unwrittenExecutionAddress = 0x1800;

  new Uint8Array(machine.memory.buffer).set([0xcc], writtenProgramAddress);
  machine.cpu.state.eip = unwrittenExecutionAddress;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "instructionLimit"
  });
  strictEqual(machine.cpu.state.eip, unwrittenExecutionAddress + 2);
  strictEqual(machine.cpu.state.instructionCount, 1);
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

test("Cpu classifies divide error from generated instruction semantics", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  new Uint8Array(machine.memory.buffer).set([0xf7, 0xf3], startAddress);
  machine.cpu.state.eip = startAddress;
  machine.cpu.state.writeReg32("eax", 0x1234_5678);
  machine.cpu.state.writeReg32("ebx", 0);
  machine.cpu.state.writeReg32("edx", 0x89ab_cdef);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: divideError()
  });
  strictEqual(machine.cpu.state.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
  strictEqual(machine.cpu.state.readReg32("eax"), 0x1234_5678);
  strictEqual(machine.cpu.state.readReg32("edx"), 0x89ab_cdef);
});

test("Cpu classifies undefined instruction before segment-load handling", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  new Uint8Array(machine.memory.buffer).set([0x8e, 0xc8], startAddress);
  machine.cpu.state.eip = startAddress;
  machine.cpu.state.writeReg32("eax", 0x1234_5678);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: invalidOpcode()
  });
  strictEqual(machine.cpu.state.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu classifies a typed segment-load request", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  new Uint8Array(machine.memory.buffer).set([0x8e, 0xc0], startAddress);
  machine.cpu.state.eip = startAddress;
  machine.cpu.state.writeReg32("eax", 0x1234_5678);

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "segmentLoad",
    segment: "es",
    selector: 0x5678
  });
  strictEqual(machine.cpu.state.eip, startAddress);
  strictEqual(machine.cpu.state.instructionCount, 0);
});

test("Cpu preserves the instruction start when fetch is truncated at guest-memory bounds", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const boundary = machine.memory.buffer.byteLength;
  const instructionStart = boundary - 1;

  new Uint8Array(machine.memory.buffer)[instructionStart] = 0xb8;
  machine.cpu.state.eip = instructionStart;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 1 }), {
    kind: "cpuException",
    exception: pageFault(boundary, PageFaultErrorCode.INSTRUCTION_FETCH)
  });
  strictEqual(machine.cpu.state.eip, instructionStart);
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
