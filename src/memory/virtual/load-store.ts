import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { Integer, I32Value } from "#compiler/function/values.js";
import type { PhysicalAccessConstruction } from "../physical.js";
import type {
  BoundMemoryAccess,
  DirectMemoryAccess,
  MemoryTransferWidth,
  ResolvedMemoryAccess
} from "../types.js";
import type { ScatteredLoadStore } from "./scattered-load-store.js";

type BoundVirtualLoadStore = Pick<
  BoundMemoryAccess,
  "load" | "loadDirect" | "store" | "storeDirect"
>;

export function virtualLoadStoreForRegion(
  region: RegionBuilder,
  physical: PhysicalAccessConstruction,
  scattered: ScatteredLoadStore
): BoundVirtualLoadStore {
  return {
    // A resolved access uses physical memory unless its pages are scattered.
    load<Width extends MemoryTransferWidth>(
      access: ResolvedMemoryAccess,
      byteOffset: I32Value,
      width: Width
    ): Integer<Width> {
      const staticScattered = region.constValue(access.scattered);

      if (staticScattered !== undefined) {
        return staticScattered !== 0
          ? scattered.load(region, linearStart(access, byteOffset), width)
          : physical.forRegion(region).load(access.physicalAccess, byteOffset, width);
      }
      return region.ifValue(
        access.scattered,
        (scatteredRegion) =>
          scattered.load(scatteredRegion, linearStart(access, byteOffset), width),
        (directRegion) =>
          physical.forRegion(directRegion).load(access.physicalAccess, byteOffset, width),
        { hint: "unlikely" }
      );
    },
    loadDirect<Width extends MemoryTransferWidth>(
      access: DirectMemoryAccess,
      byteOffset: I32Value,
      width: Width
    ): Integer<Width> {
      return physical.forRegion(region).load(access.physicalAccess, byteOffset, width);
    },
    store<Width extends MemoryTransferWidth>(
      access: ResolvedMemoryAccess<"write">,
      byteOffset: I32Value,
      value: Integer<Width>
    ): void {
      const staticScattered = region.constValue(access.scattered);

      if (staticScattered !== undefined) {
        if (staticScattered !== 0) {
          scattered.store(region, linearStart(access, byteOffset), value);
        } else {
          physical.forRegion(region).store(access.physicalAccess, byteOffset, value);
        }
        return;
      }
      region.if(
        access.scattered,
        (scatteredRegion) =>
          scattered.store(scatteredRegion, linearStart(access, byteOffset), value),
        {
          hint: "unlikely",
          elseBuild: (directRegion) =>
            physical.forRegion(directRegion).store(access.physicalAccess, byteOffset, value)
        }
      );
    },
    storeDirect<Width extends MemoryTransferWidth>(
      access: DirectMemoryAccess<"write">,
      byteOffset: I32Value,
      value: Integer<Width>
    ): void {
      physical.forRegion(region).store(access.physicalAccess, byteOffset, value);
    }
  };
}

function linearStart(access: ResolvedMemoryAccess, byteOffset: I32Value): I32Value {
  return access.range.start.add(byteOffset);
}
