import type { GuestMemory } from "#x86/memory/guest-memory.js";
import {
  GuestMemoryDecodeReader,
  type GuestMemoryDecodeRegion,
  type RegionedDecodeReader
} from "#x86/decoder/guest-memory-reader.js";
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

  createReader(memory: GuestMemory): RegionedDecodeReader {
    return new GuestMemoryDecodeReader(memory, this.#regions.map(decodeRegion));
  }
}

function decodeRegion(region: RuntimeCodeRegion): GuestMemoryDecodeRegion {
  return {
    kind: "guest-memory",
    baseAddress: region.baseAddress,
    byteLength: region.byteLength,
    ...(region.generation === undefined ? {} : { generation: region.generation })
  };
}
