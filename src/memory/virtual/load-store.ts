import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { PhysicalAccessConstruction } from "../physical.js";
import type {
  MemoryAccess,
  MemoryLoadOptions
} from "../types.js";
import type { ScatteredLoadStore } from "./scattered-load-store.js";

export type VirtualLoadStoreOperations = Readonly<{
  load(
    region: RegionBuilder,
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: MemoryLoadOptions
  ): ValueId;
  store(
    region: RegionBuilder,
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
}>;

export function createVirtualLoadStore(
  physical: PhysicalAccessConstruction,
  scattered: ScatteredLoadStore
): VirtualLoadStoreOperations {
  return {
    load: (
      region,
      access,
      byteOffset,
      width,
      options: MemoryLoadOptions = {}
    ) => buildLoad(
      physical,
      scattered,
      region,
      access,
      byteOffset,
      width,
      options
    ),
    store: (region, access, byteOffset, value, width) =>
      buildStore(
        physical,
        scattered,
        region,
        access,
        byteOffset,
        value,
        width
      )
  };
}

// Loads and stores select literal routes while building IR. A constant Wasm
// branch would be dead at runtime but would still construct the scattered
// address and retain its helper in the closed program.
function buildLoad(
  physical: PhysicalAccessConstruction,
  scattered: ScatteredLoadStore,
  region: RegionBuilder,
  access: MemoryAccess,
  byteOffset: ValueId,
  width: IntegerWidth,
  options: MemoryLoadOptions
): ValueId {
  const staticScattered = region.values.constValue(access.scattered);

  if (staticScattered !== undefined) {
    return staticScattered === 0
      ? physical.bind(region).load(
        access.physicalAccess,
        byteOffset,
        width,
        options
      )
      : scattered.load(
        region,
        linearStart(region, access, byteOffset),
        width,
        options
      );
  }

  return region.ifValue(
    access.scattered,
    (scatteredRegion) => scattered.load(
      scatteredRegion,
      linearStart(scatteredRegion, access, byteOffset),
      width,
      options
    ),
    (contiguousRegion) => physical.bind(contiguousRegion).load(
      access.physicalAccess,
      byteOffset,
      width,
      options
    ),
    { hint: "unlikely" }
  );
}

function buildStore(
  physical: PhysicalAccessConstruction,
  scattered: ScatteredLoadStore,
  region: RegionBuilder,
  access: MemoryAccess<"write">,
  byteOffset: ValueId,
  value: ValueId,
  width: IntegerWidth
): void {
  const staticScattered = region.values.constValue(access.scattered);

  if (staticScattered !== undefined) {
    if (staticScattered === 0) {
      physical.bind(region).store(
        access.physicalAccess,
        byteOffset,
        value,
        width
      );
    } else {
      scattered.store(
        region,
        linearStart(region, access, byteOffset),
        value,
        width
      );
    }
    return;
  }

  region.if(
    access.scattered,
    (scatteredRegion) => scattered.store(
      scatteredRegion,
      linearStart(scatteredRegion, access, byteOffset),
      value,
      width
    ),
    {
      hint: "unlikely",
      elseBuild: (contiguousRegion) =>
        physical.bind(contiguousRegion).store(
          access.physicalAccess,
          byteOffset,
          value,
          width
        )
    }
  );
}

function linearStart(
  region: RegionBuilder,
  access: MemoryAccess,
  byteOffset: ValueId
): ValueId {
  return region.values.binary(
    "add",
    access.range.start,
    byteOffset
  );
}
