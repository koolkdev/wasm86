import { decodeIsaInstructionFromReader } from "#core/decoder/decode.js";
import type {
  IsaDecodeReadResult,
  IsaDecodeReader,
  IsaDecodeResult
} from "#core/decoder/types.js";

const testDecodeAddress = 0x1000;

export function decodeBytes(
  bytes: readonly number[],
  address = testDecodeAddress
): IsaDecodeResult {
  return decodeIsaInstructionFromReader(
    new ByteArrayReader(bytes, address),
    address
  );
}

class ByteArrayReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(
    bytes: readonly number[],
    readonly baseAddress: number
  ) {
    this.#bytes = Uint8Array.from(bytes);
  }

  readU8(eip: number): IsaDecodeReadResult {
    const value = this.#bytes[eip - this.baseAddress];

    if (value === undefined) {
      throw new RangeError(`test instruction read outside supplied bytes at ${eip}`);
    }
    return { kind: "value", value };
  }
}
