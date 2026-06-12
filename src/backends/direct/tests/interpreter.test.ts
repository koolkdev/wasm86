import { strictEqual } from "node:assert";
import { test } from "node:test";

import { StopReason } from "#x86/execution/run-result.js";
import { createCpuState, getFlag } from "#x86/state/cpu-state.js";
import { bytes, runIsaBytes, startAddress } from "./helpers.js";

test("executes register control flow loop", () => {
  const program = bytes([
    0xb8, 0x03, 0x00, 0x00, 0x00, // mov eax, 3
    0x83, 0xe8, 0x01, // sub eax, 1
    0x75, 0xfb // jnz -5
  ]);
  const state = createCpuState({ eip: startAddress });

  const result = runIsaBytes(state, program, { baseAddress: startAddress });

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(result.finalEip, startAddress + program.length);
  strictEqual(result.instructionCount, 7);
  strictEqual(state.eax, 0);
  strictEqual(state.eip, startAddress + program.length);
  strictEqual(state.instructionCount, 7);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "PF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "AF"), false);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("executes spec-only immediate logical forms", () => {
  const state = createCpuState({ eip: startAddress });
  const program = bytes([
    0xb8, 0xff, 0xff, 0xff, 0xff, // mov eax, 0xffffffff
    0x35, 0xff, 0xff, 0xff, 0xff, // xor eax, 0xffffffff
    0xa9, 0xff, 0xff, 0xff, 0xff // test eax, 0xffffffff
  ]);

  const result = runIsaBytes(state, program, { baseAddress: startAddress });

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 0);
  strictEqual(state.eip, startAddress + program.length);
  strictEqual(state.instructionCount, 3);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("stops on unsupported opcodes", () => {
  const state = createCpuState({ eip: startAddress });
  const result = runIsaBytes(state, bytes([0x62]), { baseAddress: startAddress });

  strictEqual(result.stopReason, StopReason.UNSUPPORTED);
  strictEqual(result.unsupportedByte, 0x62);
  strictEqual(state.eip, startAddress);
  strictEqual(state.instructionCount, 0);
});

test("honors instruction limit", () => {
  const state = createCpuState({ eip: startAddress });
  const result = runIsaBytes(state, bytes([0xeb, 0xfe]), {
    baseAddress: startAddress,
    instructionLimit: 3
  });

  strictEqual(result.stopReason, StopReason.INSTRUCTION_LIMIT);
  strictEqual(state.eip, startAddress);
  strictEqual(state.instructionCount, 3);
});
