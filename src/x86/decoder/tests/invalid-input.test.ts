import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { IsaDecodeError, maxX86InstructionLength } from "#x86/decoder/reader.js";
import { decodeBytes, startAddress } from "./helpers.js";

test("reports unsupported opcode without throwing", () => {
  const decoded = decodeBytes([0x62]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.address, startAddress);
    strictEqual(decoded.length, 1);
    strictEqual(decoded.unsupportedByte, 0x62);
    deepStrictEqual(decoded.raw, [0x62]);
  }
});

test("reports unsupported opcode after prefix without throwing", () => {
  const decoded = decodeBytes([0x66, 0x62]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 2);
    strictEqual(decoded.unsupportedByte, 0x66);
    deepStrictEqual(decoded.raw, [0x66, 0x62]);
  }
});

test("truncated mov imm32 reports decode fault", () => {
  assertDecodeFault([0xb8, 0x01, 0x02]);
});

test("truncated opcode escape reports decode fault", () => {
  assertDecodeFault([0x0f]);
});

test("reports unsupported segment-register ModRM indexes", () => {
  const decoded = decodeBytes([0x8c, 0xf0]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.length, 2);
    strictEqual(decoded.unsupportedByte, 0x8c);
  }
});

test("accepts a maximum length prefixed instruction", () => {
  const bytes = [...new Array<number>(12).fill(0x66), 0xb8, 0x34, 0x12];
  const decoded = decodeBytes(bytes);

  strictEqual(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    strictEqual(decoded.instruction.length, maxX86InstructionLength);
    strictEqual(decoded.instruction.nextEip, startAddress + maxX86InstructionLength);
    deepStrictEqual(decoded.instruction.raw, bytes);
  }
});

test("overlong instructions report instruction-too-long decode faults", () => {
  assertInstructionTooLong([...new Array<number>(13).fill(0x66), 0xb8, 0x34, 0x12]);
  assertInstructionTooLong(new Array<number>(15).fill(0x66));
  assertInstructionTooLong([...new Array<number>(15).fill(0x64), 0x8b, 0x03]);
  assertInstructionTooLong([...new Array<number>(14).fill(0x66), 0x0f, 0x90]);
});

function assertDecodeFault(values: readonly number[]): void {
  throws(
    () => decodeBytes(values),
    (error: unknown) => {
      if (!(error instanceof IsaDecodeError)) {
        return false;
      }

      strictEqual(error.fault.reason, "truncated");
      return true;
    }
  );
}

function assertInstructionTooLong(values: readonly number[]): void {
  throws(
    () => decodeBytes(values),
    (error: unknown) => {
      if (!(error instanceof IsaDecodeError)) {
        return false;
      }

      strictEqual(error.fault.reason, "instructionTooLong");
      strictEqual(error.fault.address, startAddress);
      strictEqual(error.fault.offset, maxX86InstructionLength);
      deepStrictEqual(error.fault.raw, values.slice(0, maxX86InstructionLength));
      return true;
    }
  );
}
