import { decodeIsaInstructionFromReader } from "#instructions/decoder/decode.js";
import type {
  IsaDecodeReadResult,
  IsaDecodeReader,
  IsaDecodeResult
} from "#instructions/decoder/types.js";

// Minimal byte-backed reader for decoder-boundary tests.
export const startAddress = 0x1000;

export function decodeBytes(values: readonly number[], address = startAddress): IsaDecodeResult {
  return decodeIsaInstructionFromReader(new ByteArrayDecodeReader(values, address), address);
}

export class ByteArrayDecodeReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(
    values: readonly number[] | Uint8Array<ArrayBuffer>,
    readonly baseAddress = 0
  ) {
    this.#bytes = values instanceof Uint8Array ? values : Uint8Array.from(values);
  }

  readU8(eip: number): IsaDecodeReadResult {
    const index = eip - this.baseAddress;

    if (!Number.isInteger(index) || index < 0 || index >= this.#bytes.length) {
      throw testReaderFailure(eip);
    }

    const value = this.#bytes[index];

    if (value === undefined) {
      throw testReaderFailure(eip);
    }

    return { kind: "value", value };
  }
}

export type TestReaderFailure = Readonly<{
  kind: "testReaderFailure";
  address: number;
}>;

export function testReaderFailure(address: number): TestReaderFailure {
  return { kind: "testReaderFailure", address };
}

export function isTestReaderFailure(error: unknown): error is TestReaderFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "testReaderFailure"
  );
}
