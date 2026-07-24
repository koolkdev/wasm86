import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeJitBlock } from "#jit/decode-block.js";
import {
  defaultJitBlockPolicy,
  jitSnapshotRequestByteLength,
  type JitBlockPolicy
} from "#jit/policy.js";
import {
  snapshotInstructionBytes,
  type InstructionByteSnapshot
} from "#jit/instruction-snapshot.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  createTestGuestMemoryBinding
} from "#test/support/wasm-memories.js";
import { jitMemoryWithBytes } from "./memory-fixture.js";

const startAddress = 0x1000;

test("decodeJitBlock stops at an unconditional control instruction", () => {
  const block = decodeJitBlock(
    memory([0x90, 0xeb, 0x00, 0x90]),
    defaultJitBlockPolicy
  );

  strictEqual(block.instructions.length, 2);
  strictEqual(block.terminator.kind, "control");
  if (block.terminator.kind === "control") {
    strictEqual(block.terminator.instruction.spec.mnemonic, "jmp");
  }
});

test("decodeJitBlock keeps conditional control inside fallthrough blocks", () => {
  const block = decodeJitBlock(
    memory([0x90, 0x75, 0x00, 0x90]),
    { instructionLimit: 3 }
  );

  strictEqual(block.instructions.length, 3);
  deepStrictEqual(block.terminator, {
    kind: "fallthrough",
    nextEip: startAddress + 4
  });
});

test("decodeJitBlock returns fallthrough when its instruction limit ends the block", () => {
  const block = decodeJitBlock(
    memory([0x90, 0x90, 0xcd, 0x2e]),
    { instructionLimit: 2 }
  );

  strictEqual(block.instructions.length, 2);
  deepStrictEqual(block.terminator, { kind: "fallthrough", nextEip: startAddress + 2 });
});

test("decodeJitBlock carries a first-instruction invalid-opcode terminal", () => {
  const block = decodeJitBlock(memory([0x62]), defaultJitBlockPolicy);

  strictEqual(block.instructions.length, 0);
  strictEqual(block.terminator.kind, "cpuException");
  if (block.terminator.kind === "cpuException") {
    deepStrictEqual(block.terminator.exception, { kind: "UD" });
    strictEqual(block.terminator.instructionStart, startAddress);
  }
});

test("decodeJitBlock places invalid opcode after a decoded instruction prefix", () => {
  const block = decodeJitBlock(
    memory([0x90, 0x62, 0x90]),
    defaultJitBlockPolicy
  );

  strictEqual(block.instructions.length, 1);
  strictEqual(block.terminator.kind, "cpuException");
  if (block.terminator.kind === "cpuException") {
    deepStrictEqual(block.terminator.exception, { kind: "UD" });
    strictEqual(block.terminator.instructionStart, startAddress + 1);
  }
});

test("decodeJitBlock places a fetch page fault after decoded instructions", () => {
  const instructionStart = guestMemoryMinimumByteLength - 2;
  const block = decodeJitBlock(
    memory([0x90, 0xb8], instructionStart),
    defaultJitBlockPolicy
  );

  strictEqual(block.instructions.length, 1);
  strictEqual(block.terminator.kind, "cpuException");
  if (block.terminator.kind === "cpuException") {
    deepStrictEqual(
      block.terminator.exception,
      {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 16
      }
    );
    strictEqual(block.terminator.instructionStart, guestMemoryMinimumByteLength - 1);
  }
});

function memory(
  values: readonly number[],
  address = startAddress,
  policy: JitBlockPolicy = defaultJitBlockPolicy
): InstructionByteSnapshot {
  const guestMemory = jitMemoryWithBytes(values, address);
  const reader = createTestGuestMemoryBinding(
    guestMemory
  ).reader;

  return snapshotInstructionBytes(
    reader,
    {
      linearStart: address,
      byteLength: jitSnapshotRequestByteLength(policy)
    }
  );
}
