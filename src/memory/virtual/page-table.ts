import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import type {
  ResourceByteOperand,
  ResourceEffect
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { MachineMemoryDefinition } from "../machine-memory.js";
import { pageTableEntries } from "./layout.js";

export type PageTableAccess = Readonly<{
  effect: ResourceEffect;
  read(region: RegionBuilder, page: ValueId): ValueId;
}>;

export function createPageTableAccess(
  machineMemory: MachineMemoryDefinition
): PageTableAccess {
  const entries = machineMemory.layout.array(pageTableEntries);
  const effect: ResourceEffect = {
    space: "resource",
    resource: machineMemory.resource,
    range: {
      basis: { kind: "resource" },
      slice: {
        byteOffset: entries.offset,
        byteLength: entries.stride * entries.count
      }
    }
  };

  return {
    effect,
    read: (region, page) => {
      const source: ResourceByteOperand = {
        effect,
        address: {
          base: region.values.binary(
            "mul",
            page,
            region.values.const(entries.stride)
          ),
          displacement: entries.offset
        },
        width: 32
      };

      return region.operation(resourceRead, { source });
    }
  };
}
