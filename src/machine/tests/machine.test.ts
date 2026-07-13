import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createMachine } from "#machine/machine.js";
import { wasmPageByteLength } from "#wasm/abi.js";

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

test("machine creates one Cpu with writable default state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const { state } = machine.cpu;

  strictEqual(state.eip, 0);
  strictEqual(state.readReg32("eax"), 0);
  strictEqual(state.readFlag("CF"), false);

  state.eip = 0x1000;
  state.writeReg32("eax", 0x1234_5678);
  state.writeSegmentBase("fs", 0x8000_0000);
  state.writeFlag("CF", true);

  strictEqual(state.eip, 0x1000);
  strictEqual(state.readReg32("eax"), 0x1234_5678);
  strictEqual(state.readSegmentBase("fs"), 0x8000_0000);
  strictEqual(state.readFlag("CF"), true);
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

test("machine exposes only its memory and single Cpu", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  deepStrictEqual(Object.keys(machine), ["memory", "cpu"]);
  deepStrictEqual(Object.keys(machine.cpu), ["state", "run"]);
  strictEqual(typeof machine.cpu.run, "function");
  strictEqual("createCpu" in machine, false);
  strictEqual(Object.isFrozen(machine), false);
});
