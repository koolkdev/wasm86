import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeIsaBlock } from "#x86/decoder/decode-block.js";
import { X86_32_CORE } from "#x86/index.js";
import { ByteArrayDecodeReader, imm8 } from "./helpers.js";

const startAddress = 0x1000;
const instructionLengthLimit = X86_32_CORE.instructionLengthLimit;

test("decodeIsaBlock_decodes_until_unconditional_control_instruction", () => {
  for (const [bytes, id] of [
    [[0xeb, 0x00], "jmp.rel8"],
    [[0xe8, 0x00, 0x00, 0x00, 0x00], "call.rel32"],
    [[0xc3], "ret.near"],
    [[0xcd, 0x2e], "int.imm8"],
    [[0xcc], "int3.near"]
  ] as const) {
    const block = decodeIsaBlock(byteReader([
      0x90,
      ...bytes,
      0x90
    ]), startAddress);

    deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32", id]);
    strictEqual(block.terminator.kind, "control", id);

    if (id === "int.imm8" && block.terminator.kind === "control") {
      deepStrictEqual(block.terminator.instruction.operands, [imm8(0x2e)]);
    }
  }
});

test("decodeIsaBlock_keeps_conditional_control_inside_fallthrough_blocks", () => {
  for (const [bytes, id] of [
    [[0xce], "into.near"],
    [[0x75, 0x00], "jne.rel8"],
    [[0xe3, 0x00], "jecxz.rel8"],
    [[0xe2, 0x00], "loop.rel8"],
    [[0xe1, 0x00], "loope.rel8"],
    [[0xe0, 0x00], "loopne.rel8"]
  ] as const) {
    const block = decodeIsaBlock(byteReader([
      0x90,
      ...bytes,
      0x90
    ]), startAddress, { maxInstructions: 3 });

    deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), [
      "xchg.eax_r32",
      id,
      "xchg.eax_r32"
    ]);
    deepStrictEqual(block.terminator, {
      kind: "fallthrough",
      nextEip: startAddress + bytes.length + 2
    });
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

test("decodeIsaBlock_reports_decode_fault_without_byte_slice", () => {
  const values = [0x90, 0xb8, 0x01];
  const block = decodeIsaBlock(new ByteArrayDecodeReader(values, startAddress), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  strictEqual(block.terminator.kind, "decode-fault");
  if (block.terminator.kind === "decode-fault") {
    strictEqual(block.terminator.fault.address, startAddress + 1);
    deepStrictEqual(block.terminator.fault.raw, [0xb8, 0x01]);
  }
});
