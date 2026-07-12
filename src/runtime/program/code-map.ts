import { readBackingByte } from "#memory/bytes.js";
import { truncatedInstructionFault, IsaDecodeError, type IsaDecodeReader } from "#core/decoder/reader.js";
import { regionContains, type RuntimeCodeRegion } from "./regions.js";

export class RuntimeCodeMap {
  readonly #regions: readonly RuntimeCodeRegion[];

  constructor(regions: readonly RuntimeCodeRegion[]) {
    this.#regions = [...regions];
  }

  get regions(): readonly RuntimeCodeRegion[] {
    return this.#regions;
  }

  contains(eip: number): boolean {
    return this.#regions.some((region) => regionContains(region, eip));
  }

  createReader(memory: WebAssembly.Memory): IsaDecodeReader {
    return new RuntimeCodeMapReader(memory, this.#regions);
  }
}

export class RuntimeCodeMapReader implements IsaDecodeReader {
  constructor(
    readonly memory: WebAssembly.Memory,
    readonly regions: readonly RuntimeCodeRegion[]
  ) {}

  readU8(eip: number): number {
    if (!this.regions.some((region) => regionContains(region, eip))) {
      throw new IsaDecodeError(truncatedInstructionFault(eip));
    }

    const value = readBackingByte(this.memory, eip);
    if (value === undefined) {
      throw new IsaDecodeError(truncatedInstructionFault(eip));
    }
    return value;
  }
}
