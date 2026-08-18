import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { Integer, I32Value } from "#compiler/function/values.js";
import type { MachineMemoryDefinition } from "../machine-memory.js";
import { pageTableEntries } from "./layout.js";

export type PageTableAccess = Readonly<{
  effect: ResourceEffect;
  read(region: RegionBuilder, page: Integer<32>): I32Value;
}>;

export function createPageTableAccess(machineMemory: MachineMemoryDefinition): PageTableAccess {
  const entries = machineMemory.layout.array(pageTableEntries);
  const effect: ResourceEffect = {
    kind: "resource",
    resource: machineMemory.resource,
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset: entries.offset,
      byteLength: entries.stride * entries.count
    }
  };

  return {
    effect,
    read: (region, page) => {
      const source: ResourceAccess<32> = {
        effect,
        address: {
          base: page.mul(entries.stride),
          displacement: entries.offset
        },
        storageWidth: 32,
        valueWidth: 32
      };

      return region.readResource(source);
    }
  };
}
