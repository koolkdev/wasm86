import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createMachine } from "#machine/machine.js";

test("the default public Machine executes a short program", () => {
  const machine = createMachine({ memoryByteLength: 0x1_1000 });
  const start = machine.memory.buffer.byteLength - 0x1000;

  // prettier-ignore
  new Uint8Array(machine.memory.buffer).set([
    0xb8, 0x78, 0x56, 0x34, 0x12,
    0xcd, 0x2e
  ], start);
  machine.cpu.state.core.eip = start;

  deepStrictEqual(machine.cpu.run({ instructionBudget: 2 }), {
    kind: "hostTrap",
    vector: 0x2e
  });
  strictEqual(machine.cpu.state.core.readReg32("eax"), 0x1234_5678);
  strictEqual(machine.cpu.state.core.eip, start + 7);
});
