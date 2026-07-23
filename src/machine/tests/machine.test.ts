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

test("machine creates one Cpu with writable default state", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });
  const { core, flags } = machine.cpu.state;

  strictEqual(core.eip, 0);
  strictEqual(core.readReg32("eax"), 0);
  strictEqual(flags.readFlag("CF"), false);

  core.eip = 0x1000;
  core.writeReg32("eax", 0x1234_5678);
  core.writeSegmentSelector("fs", 0x30);
  core.writeSegmentBase("fs", 0x8000_0000);
  core.writeSegmentLimit("fs", 0xffff_ffff);
  core.writeSegmentAccess("fs", 0x00c0_00fb);
  flags.writeFlag("CF", true);

  strictEqual(core.eip, 0x1000);
  strictEqual(core.readReg32("eax"), 0x1234_5678);
  strictEqual(core.readSegmentSelector("fs"), 0x30);
  strictEqual(core.readSegmentBase("fs"), 0x8000_0000);
  strictEqual(core.readSegmentLimit("fs"), 0xffff_ffff);
  strictEqual(core.readSegmentAccess("fs"), 0x00c0_00fb);
  strictEqual(flags.readFlag("CF"), true);
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

test("machine exposes only its memory and single Cpu", () => {
  const machine = createMachine({ memoryByteLength: 0x1000 });

  deepStrictEqual(Object.keys(machine), ["memory", "cpu"]);
  deepStrictEqual(Object.keys(machine.cpu), ["state", "run"]);
  strictEqual(typeof machine.cpu.run, "function");
  strictEqual("createCpu" in machine, false);
  strictEqual(Object.isFrozen(machine), false);
});
