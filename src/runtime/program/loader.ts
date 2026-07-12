import { writeBackingBytes } from "#memory/bytes.js";
import type { RuntimeProgramRegion } from "./regions.js";

export function loadProgramRegions(
  memory: WebAssembly.Memory,
  regions: readonly RuntimeProgramRegion[]
): number | undefined {
  for (const region of regions) {
    const fault = writeBackingBytes(memory, region.baseAddress, region.bytes);

    if (fault !== undefined) {
      return fault;
    }
  }

  return undefined;
}
