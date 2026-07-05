import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { GuestMemoryDecodeReader } from "#x86/decoder/guest-memory-reader.js";
import { decodeIsaBlock } from "#x86/decoder/decode-block.js";
import { X86_32_CORE } from "#x86/index.js";
import { ByteArrayDecodeReader, imm8 } from "./helpers.js";

const startAddress = 0x1000;
const instructionLengthLimit = X86_32_CORE.instructionLengthLimit;

test("decodeIsaBlock_decodes_until_control_instruction", () => {
  const block = decodeIsaBlock(byteReader([
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0x83, 0xc0, 0x02,
    0xeb, 0x00
  ]), startAddress);

  strictEqual(block.startEip, startAddress);
  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), [
    "mov.r32_imm32",
    "add.rm32_imm8",
    "jmp.rel8"
  ]);
  strictEqual(block.terminator.kind, "control");
});

test("decodeIsaBlock_stops_after_ret_control_instruction", () => {
  const block = decodeIsaBlock(byteReader([
    0x90,
    0xc3,
    0x90
  ]), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32", "ret.near"]);
  strictEqual(block.terminator.kind, "control");
});

test("decodeIsaBlock_stops_after_int_control_instruction", () => {
  const block = decodeIsaBlock(byteReader([
    0x90,
    0xcd, 0x2e,
    0x90
  ]), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32", "int.imm8"]);
  strictEqual(block.terminator.kind, "control");
  if (block.terminator.kind === "control") {
    deepStrictEqual(block.terminator.instruction.operands, [imm8(0x2e)]);
  }
});

test("decodeIsaBlock_returns_fallthrough_when_instruction_limit_ends_block", () => {
  const block = decodeIsaBlock(byteReader([
    0x90,
    0x90,
    0xcd, 0x2e
  ]), startAddress, { maxInstructions: 2 });

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32", "xchg.eax_r32"]);
  deepStrictEqual(block.terminator, { kind: "fallthrough", nextEip: startAddress + 2 });
});

test("decodeIsaBlock_reports_unsupported_without_caching_raw_block_state", () => {
  const block = decodeIsaBlock(byteReader([0x62]), startAddress);

  deepStrictEqual(block.instructions, []);
  deepStrictEqual(block.terminator, {
    kind: "unsupported",
    address: startAddress,
    length: 1,
    raw: [0x62],
    unsupportedByte: 0x62
  });
});

test("decodeIsaBlock_reports_unsupported_after_valid_prefix_instructions", () => {
  const block = decodeIsaBlock(byteReader([
    0x90,
    0x62,
    0x90
  ]), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  deepStrictEqual(block.terminator, {
    kind: "unsupported",
    address: startAddress + 1,
    length: 1,
    raw: [0x62],
    unsupportedByte: 0x62
  });
});

test("decodeIsaBlock_reports_decode_fault_after_valid_prefix_instructions", () => {
  const block = decodeIsaBlock(byteReader([
    0x90,
    0xb8, 0x01
  ]), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  strictEqual(block.terminator.kind, "decode-fault");
  strictEqual(block.terminator.fault.address, startAddress + 1);
  deepStrictEqual(block.terminator.fault.raw, [0xb8, 0x01]);
});

test("decodeIsaBlock_preserves_instruction_too_long_faults", () => {
  const values = [...new Array<number>(13).fill(0x66), 0xb8, 0x34, 0x12];
  const block = decodeIsaBlock(byteReader(values), startAddress);

  strictEqual(block.terminator.kind, "decode-fault");
  if (block.terminator.kind === "decode-fault") {
    strictEqual(block.terminator.fault.reason, "instructionTooLong");
    strictEqual(block.terminator.fault.address, startAddress);
    strictEqual(block.terminator.fault.offset, instructionLengthLimit);
    deepStrictEqual(block.terminator.fault.raw, values.slice(0, instructionLengthLimit));
  }
});

function byteReader(values: readonly number[]): ByteArrayDecodeReader {
  return new ByteArrayDecodeReader(values, startAddress);
}

test("decodeIsaBlock_reports_guest_memory_decode_fault_without_byte_slice", () => {
  const memory = new ArrayBufferGuestMemory(startAddress + 3);
  const values = [0x90, 0xb8, 0x01];

  for (let index = 0; index < values.length; index += 1) {
    memory.writeU8(startAddress + index, values[index] ?? 0);
  }

  const block = decodeIsaBlock(
    new GuestMemoryDecodeReader(memory, [
      { kind: "guest-memory", baseAddress: startAddress, byteLength: values.length }
    ]),
    startAddress
  );

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  strictEqual(block.terminator.kind, "decode-fault");
  if (block.terminator.kind === "decode-fault") {
    strictEqual(block.terminator.fault.address, startAddress + 1);
    deepStrictEqual(block.terminator.fault.raw, [0xb8, 0x01]);
  }
});
