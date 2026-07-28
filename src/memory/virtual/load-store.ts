import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import type { PhysicalAccessConstruction } from "../physical.js";
import type {
  BoundMemoryAccess,
  DirectMemoryAccess,
  MemoryLoadOptions,
  ResolvedMemoryAccess
} from "../types.js";
import type { ScatteredLoadStore } from "./scattered-load-store.js";

type BoundVirtualLoadStore = Pick<
  BoundMemoryAccess,
  "load" | "loadDirect" | "store" | "storeDirect"
>;

export function bindVirtualLoadStore(
  region: RegionBuilder,
  physical: PhysicalAccessConstruction,
  scattered: ScatteredLoadStore
): BoundVirtualLoadStore {
  return {
    // A resolved access uses physical memory unless its pages are scattered.
    load(
      access: ResolvedMemoryAccess,
      byteOffset: ValueId,
      width: IntegerWidth,
      options: MemoryLoadOptions = {}
    ): ValueId {
      const staticScattered = region.values.constValue(access.scattered);

      if (staticScattered !== undefined) {
        return staticScattered !== 0
          ? scattered.load(region, linearStart(region, access, byteOffset), width, options)
          : physical.bind(region).load(access.physicalAccess, byteOffset, width, options);
      }

      return region.ifValue(
        access.scattered,
        (scatteredRegion) =>
          scattered.load(
            scatteredRegion,
            linearStart(scatteredRegion, access, byteOffset),
            width,
            options
          ),
        (directRegion) =>
          physical.bind(directRegion).load(access.physicalAccess, byteOffset, width, options),
        { hint: "unlikely" }
      );
    },
    loadDirect(
      access: DirectMemoryAccess,
      byteOffset: ValueId,
      width: IntegerWidth,
      options: MemoryLoadOptions = {}
    ): ValueId {
      return physical.bind(region).load(access.physicalAccess, byteOffset, width, options);
    },
    store(
      access: ResolvedMemoryAccess<"write">,
      byteOffset: ValueId,
      value: ValueId,
      width: IntegerWidth
    ): void {
      const staticScattered = region.values.constValue(access.scattered);

      if (staticScattered !== undefined) {
        if (staticScattered !== 0) {
          scattered.store(region, linearStart(region, access, byteOffset), value, width);
        } else {
          physical.bind(region).store(access.physicalAccess, byteOffset, value, width);
        }
        return;
      }

      region.if(
        access.scattered,
        (scatteredRegion) =>
          scattered.store(
            scatteredRegion,
            linearStart(scatteredRegion, access, byteOffset),
            value,
            width
          ),
        {
          hint: "unlikely",
          elseBuild: (directRegion) =>
            physical.bind(directRegion).store(access.physicalAccess, byteOffset, value, width)
        }
      );
    },
    storeDirect(
      access: DirectMemoryAccess<"write">,
      byteOffset: ValueId,
      value: ValueId,
      width: IntegerWidth
    ): void {
      physical.bind(region).store(access.physicalAccess, byteOffset, value, width);
    }
  };
}

function linearStart(
  region: RegionBuilder,
  access: ResolvedMemoryAccess,
  byteOffset: ValueId
): ValueId {
  return region.values.binary("add", access.range.start, byteOffset);
}
