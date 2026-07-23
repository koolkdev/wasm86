import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { wasmPageByteLength } from "#compiler/program/limits.js";
import { createMachine } from "#machine/machine.js";

test("machine exposes memory for caller initialization", () => {
  const machine = createMachine({
    memoryByteLength: wasmPageByteLength + 0x1000
  });
  const bytes = new Uint8Array(machine.memory.buffer);

  bytes.set([0x90, 0xcd, 0x80], 0x1000);

  strictEqual(bytes.byteLength, 2 * wasmPageByteLength);
  deepStrictEqual(bytes.slice(0x1000, 0x1003), Uint8Array.of(0x90, 0xcd, 0x80));
});

test("machine rounds x86-page-aligned sizes to WebAssembly pages", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  strictEqual(machine.memory.buffer.byteLength, wasmPageByteLength);
});

test("machine exposes writable Cpu state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const { core } = machine.cpu.state;

  strictEqual(core.eip, 0);
  core.eip = 0x1000;
  strictEqual(core.eip, 0x1000);
});

test("machines do not share guest memory or Cpu state", () => {
  const first = createMachine({ memoryByteLength: 0x1000 });
  const second = createMachine({ memoryByteLength: 0x1000 });

  new Uint8Array(first.memory.buffer)[0] = 0x90;
  first.cpu.state.core.writeReg32("eax", 0x1234_5678);

  strictEqual(new Uint8Array(second.memory.buffer)[0], 0);
  strictEqual(second.cpu.state.core.readReg32("eax"), 0);
});

test("machine requires a positive x86-page-aligned size", () => {
  for (const memoryByteLength of [
    0,
    -0x1000,
    1,
    0x1001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x1_0000_1000
  ]) {
    throws(
      () => createMachine({ memoryByteLength }),
      /memoryByteLength must be a positive 4 KiB-aligned integer/
    );
  }
});
