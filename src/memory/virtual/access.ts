import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import { i32 } from "#compiler/function/values.js";
import { pageFault, pageFaultErrorCode } from "#core/exceptions.js";
import type { MachineMemoryDefinition } from "../machine-memory.js";
import type { PhysicalAddressSpaceDefinition } from "../physical.js";
import type {
  BoundMemoryAccess,
  DirectMemoryResolution,
  LinearRange,
  MemoryAccess,
  MemoryAccessIntent,
  MemoryResolution
} from "../types.js";
import { pageTableEntryAttr } from "./layout.js";
import { createCachedPageTableAccess } from "./page-cache.js";
import { createScatteredLoadStore, type ScatteredLoadStore } from "./scattered-load-store.js";
import { createPageTableAccess, type PageTableAccess } from "./page-table.js";
import { VirtualRangeResolver } from "./resolution.js";
import { virtualLoadStoreForRegion } from "./load-store.js";

export type VirtualAccessDefinition = Readonly<{
  access: MemoryAccess;
  effects: StorageEffects;
}>;

export function createVirtualAccessDefinition(
  physical: PhysicalAddressSpaceDefinition,
  machineMemory: MachineMemoryDefinition
): VirtualAccessDefinition {
  const pageTable = createPageTableAccess(machineMemory);
  const rangeResolver = new VirtualRangeResolver(pageTable);
  const scattered = createScatteredLoadStore(physical, pageTable);
  return {
    access: createAccess(physical, rangeResolver, pageTable, scattered),
    effects: {
      reads: [pageTable.effect, ...physical.effects.reads],
      writes: physical.effects.writes
    }
  };
}

function createAccess(
  physical: PhysicalAddressSpaceDefinition,
  rangeResolver: VirtualRangeResolver,
  firstEntrySource: PageTableAccess,
  scattered: ScatteredLoadStore
): MemoryAccess {
  return {
    forRegion: (region) =>
      virtualAccessForRegion(region, physical, rangeResolver, firstEntrySource, scattered),
    withCache: (root) =>
      createAccess(
        physical,
        rangeResolver,
        createCachedPageTableAccess(root, firstEntrySource),
        scattered
      )
  };
}

function virtualAccessForRegion(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  rangeResolver: VirtualRangeResolver,
  firstEntrySource: PageTableAccess,
  scattered: ScatteredLoadStore
): BoundMemoryAccess {
  const resolve = <TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent> => {
    const resolution = rangeResolver.resolve(
      region,
      range,
      requiredEntryBits(intent),
      firstEntrySource
    );
    const faultError = i32(pageFaultErrorCode(intent)).or(resolution.deniedPresent);

    return {
      access: {
        range,
        intent,
        scattered: resolution.scattered,
        physicalAccess: physical.access.forRegion(region).issue({
          start: resolution.firstPhysicalStart,
          byteLength: range.byteLength
        })
      },
      fault: {
        condition: resolution.denied,
        exception: pageFault(resolution.deniedAddress, faultError)
      }
    };
  };
  const resolveDirect = <TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): DirectMemoryResolution<TIntent> => {
    const resolution = rangeResolver.resolveDirect(
      region,
      range,
      requiredEntryBits(intent),
      firstEntrySource
    );

    return {
      unavailable: resolution.unavailable,
      access: {
        intent,
        physicalAccess: physical.access.forRegion(region).issue({
          start: resolution.firstPhysicalStart,
          byteLength: range.byteLength
        })
      }
    };
  };

  return {
    resolve,
    resolveDirect,
    ...virtualLoadStoreForRegion(region, physical.access, scattered)
  };
}

function requiredEntryBits(intent: MemoryAccessIntent): number {
  return intent === "write"
    ? pageTableEntryAttr.PRESENT | pageTableEntryAttr.WRITABLE
    : pageTableEntryAttr.PRESENT;
}
