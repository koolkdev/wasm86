import { assert } from "#common/assert.js";
import type { PageFault } from "#core/exceptions.js";
import type {
  GuestMemoryByteRead,
  GuestMemoryReader
} from "#memory/types.js";

declare const instructionByteSnapshotBrand: unique symbol;

export type InstructionSnapshotRequest = Readonly<{
  linearStart: number;
  byteLength: number;
}>;

// The bytes stay private so callers can only observe this immutable value
// through checked instruction-fetch reads.
export type InstructionByteSnapshot = Readonly<{
  [instructionByteSnapshotBrand]: true;
  linearStart: number;
  readByte(linearAddress: number): GuestMemoryByteRead;
}>;

export function snapshotInstructionBytes(
  reader: GuestMemoryReader,
  request: InstructionSnapshotRequest
): InstructionByteSnapshot {
  const { linearStart, byteLength } = request;
  const bytes: number[] = [];

  for (let index = 0; index < byteLength; index += 1) {
    const read = reader.readByte(linearStart + index, "instructionFetch");

    if (read.kind === "exception") {
      return new CopiedInstructionByteSnapshot(
        linearStart,
        new Uint8Array(bytes),
        read.exception
      );
    }
    bytes.push(read.value);
  }

  return new CopiedInstructionByteSnapshot(
    linearStart,
    new Uint8Array(bytes)
  );
}

class CopiedInstructionByteSnapshot implements InstructionByteSnapshot {
  declare readonly [instructionByteSnapshotBrand]: true;
  readonly linearStart: number;
  readonly #bytes: Uint8Array<ArrayBuffer>;
  readonly #unreadableBoundary: PageFault<number> | undefined;

  constructor(
    linearStart: number,
    bytes: Uint8Array<ArrayBuffer>,
    unreadableBoundary?: PageFault<number>
  ) {
    this.linearStart = linearStart;
    this.#bytes = bytes;
    this.#unreadableBoundary = unreadableBoundary;
  }

  readByte(linearAddress: number): GuestMemoryByteRead {
    const offset = linearAddress - this.linearStart;

    if (offset >= 0 && offset < this.#bytes.byteLength) {
      const value = this.#bytes[offset];

      assert(
        value !== undefined,
        `missing instruction snapshot byte at offset ${offset}`
      );
      return { kind: "value", value };
    }

    if (this.#unreadableBoundary?.linearAddress === linearAddress) {
      return {
        kind: "exception",
        exception: this.#unreadableBoundary
      };
    }

    assert(
      false,
      `instruction snapshot read 0x${linearAddress.toString(16)} lies outside its copied prefix and unreadable boundary`
    );
  }
}
