import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeIsaInstructionFromReader } from "#instructions/decoder/decode.js";
import type {
  IsaDecodeReadResult,
  IsaDecodeReader
} from "#instructions/decoder/types.js";
import {
  PageFaultErrorCode,
  pageFault
} from "#core/exceptions.js";
import { X86_32_CORE } from "#instructions/isa/x86-32.js";
import {
  ByteArrayDecodeReader,
  decodeBytes,
  startAddress
} from "./byte-reader-fixture.js";

const instructionLengthLimit = X86_32_CORE.instructionLengthLimit;

test("an undefined opcode produces UD at its first decisive byte", () => {
  const reader = new TrackingDecodeReader([0x62, 0x90, 0x90]);
  const decoded = decodeIsaInstructionFromReader(reader, startAddress);

  strictEqual(decoded.kind, "cpuException");
  if (decoded.kind !== "cpuException") {
    return;
  }
  deepStrictEqual(decoded.exception, { kind: "UD" });
  strictEqual(decoded.instructionStart, startAddress);
  deepStrictEqual(decoded.raw, [0x62]);
  deepStrictEqual(reader.requests, [startAddress]);
});

test("an undefined opcode after prefixes records the consumed evidence", () => {
  const decoded = decodeBytes([0x66, 0x62]);

  strictEqual(decoded.kind, "cpuException");
  if (decoded.kind !== "cpuException") {
    return;
  }
  deepStrictEqual(decoded.exception, { kind: "UD" });
  strictEqual(decoded.instructionStart, startAddress);
  deepStrictEqual(decoded.raw, [0x66, 0x62]);
});

test("a reader CPU exception retains the bytes admitted before its fault", () => {
  const requests: number[] = [];
  const exception = pageFault(
    startAddress + 1,
    PageFaultErrorCode.INSTRUCTION_FETCH
  );
  const reader: IsaDecodeReader = {
    readU8(address) {
      requests.push(address);
      return address === startAddress
        ? { kind: "value", value: 0xb8 }
        : { kind: "exception", exception };
    }
  };
  const decoded = decodeIsaInstructionFromReader(reader, startAddress);

  strictEqual(decoded.kind, "cpuException");
  if (decoded.kind !== "cpuException") {
    return;
  }
  deepStrictEqual(decoded.exception, exception);
  strictEqual(decoded.instructionStart, startAddress);
  deepStrictEqual(decoded.raw, [0xb8]);
  deepStrictEqual(requests, [startAddress, startAddress + 1]);
});

test("invalid segment-register ModRM indexes produce UD", () => {
  for (const opcode of [0x8c, 0x8e]) {
    const decoded = decodeBytes([opcode, 0xf0]);

    strictEqual(decoded.kind, "cpuException");
    if (decoded.kind !== "cpuException") {
      continue;
    }
    deepStrictEqual(decoded.exception, { kind: "UD" });
    strictEqual(decoded.instructionStart, startAddress);
    deepStrictEqual(decoded.raw, [opcode, 0xf0]);
  }
});

test("an invalid ModRM group does not demand its address tail", () => {
  // F7 /1 is undefined. rm=101 would require a disp32 if the form matched.
  const reader = new TrackingDecodeReader([0xf7, 0x0d]);
  const decoded = decodeIsaInstructionFromReader(reader, startAddress);

  strictEqual(decoded.kind, "cpuException");
  if (decoded.kind !== "cpuException") {
    return;
  }
  deepStrictEqual(decoded.exception, { kind: "UD" });
  deepStrictEqual(decoded.raw, [0xf7, 0x0d]);
  deepStrictEqual(reader.requests, addresses(2));
});

test("a maximum-length prefixed instruction remains valid", () => {
  const values = [...new Array<number>(12).fill(0x66), 0xb8, 0x34, 0x12];
  const decoded = decodeBytes(values);

  strictEqual(decoded.kind, "instruction");
  if (decoded.kind !== "instruction") {
    return;
  }
  strictEqual(decoded.instruction.length, instructionLengthLimit);
  strictEqual(
    decoded.instruction.nextEip,
    startAddress + instructionLengthLimit
  );
  deepStrictEqual(decoded.instruction.raw, values);
});

test("fifteen prefixes produce GP(0) without requesting byte 16", () => {
  const values = [
    ...new Array<number>(instructionLengthLimit).fill(0x66),
    0x90
  ];
  const reader = new TrackingDecodeReader(values);
  const decoded = decodeIsaInstructionFromReader(reader, startAddress);

  strictEqual(decoded.kind, "cpuException");
  if (decoded.kind !== "cpuException") {
    return;
  }
  deepStrictEqual(decoded.exception, { kind: "GP", errorCode: 0 });
  strictEqual(decoded.instructionStart, startAddress);
  deepStrictEqual(decoded.raw, values.slice(0, instructionLengthLimit));
  deepStrictEqual(reader.requests, addresses(instructionLengthLimit));
});

test("long immediate, ModRM, and opcode tails use the same GP admission", () => {
  const cases = [
    [...new Array<number>(13).fill(0x66), 0xb8, 0x34, 0x12],
    [...new Array<number>(14).fill(0x64), 0x8b, 0x03],
    [...new Array<number>(14).fill(0x66), 0x0f, 0x90],
    [...new Array<number>(11).fill(0x64), 0x8b, 0x84, 0x00, 0x11, 0x22]
  ];

  for (const values of cases) {
    const reader = new TrackingDecodeReader(values);
    const decoded = decodeIsaInstructionFromReader(reader, startAddress);

    strictEqual(decoded.kind, "cpuException");
    if (decoded.kind !== "cpuException") {
      continue;
    }
    deepStrictEqual(decoded.exception, { kind: "GP", errorCode: 0 });
    strictEqual(decoded.instructionStart, startAddress);
    deepStrictEqual(decoded.raw, values.slice(0, instructionLengthLimit));
    deepStrictEqual(reader.requests, addresses(instructionLengthLimit));
  }
});

test("instruction-byte addresses wrap as u32", () => {
  const wrappedStart = 0xffff_ffff;
  const requests: number[] = [];
  const reader: IsaDecodeReader = {
    readU8(address) {
      requests.push(address);

      if (address === wrappedStart) {
        return { kind: "value", value: 0x66 };
      }
      if (address === 0) {
        return { kind: "value", value: 0x90 };
      }

      throw new Error(`unexpected wrapped decode address: ${address}`);
    }
  };
  const decoded = decodeIsaInstructionFromReader(reader, wrappedStart);

  strictEqual(decoded.kind, "instruction");
  if (decoded.kind !== "instruction") {
    return;
  }
  strictEqual(decoded.instruction.length, 2);
  strictEqual(decoded.instruction.nextEip, 1);
  deepStrictEqual(decoded.instruction.raw, [0x66, 0x90]);
  deepStrictEqual(requests, [wrappedStart, 0]);
});

function addresses(count: number): readonly number[] {
  return Array.from({ length: count }, (_, offset) => startAddress + offset);
}

class TrackingDecodeReader implements IsaDecodeReader {
  readonly requests: number[] = [];
  readonly #source: ByteArrayDecodeReader;

  constructor(values: readonly number[]) {
    this.#source = new ByteArrayDecodeReader(values, startAddress);
  }

  readU8(address: number): IsaDecodeReadResult {
    this.requests.push(address);
    return this.#source.readU8(address);
  }
}
