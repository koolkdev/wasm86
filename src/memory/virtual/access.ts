import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import {
  pageFault,
  pageFaultErrorCode
} from "#core/exceptions.js";
import type { MachineMemoryDefinition } from "../machine-memory.js";
import type { PhysicalAddressSpaceDefinition } from "../physical.js";
import type {
  LinearRange,
  MemoryAccess,
  MemoryAccessConstruction,
  MemoryAccessIntent,
  MemoryAccessOperations,
  MemoryLoadOptions,
  MemoryResolution
} from "../types.js";
import { pageTableEntryAttr } from "./layout.js";
import { createScatteredLoadStore } from "./scattered-load-store.js";
import { createPageTableAccess } from "./page-table.js";
import {
  createRangeResolver,
  type RangeResolver
} from "./resolution.js";
import {
  createVirtualLoadStore,
  type VirtualLoadStoreOperations
} from "./load-store.js";

export type VirtualAccessDefinition = Readonly<{
  access: MemoryAccessConstruction;
  effects: StorageEffects;
}>;

export function createVirtualAccessDefinition(
  physical: PhysicalAddressSpaceDefinition,
  machineMemory: MachineMemoryDefinition
): VirtualAccessDefinition {
  const pageTable = createPageTableAccess(machineMemory);
  const rangeResolver = createRangeResolver(pageTable);
  const scattered = createScatteredLoadStore(physical, pageTable);
  const loadStore = createVirtualLoadStore(
    physical.access,
    scattered
  );

  return {
    access: {
      bind: (region) => new VirtualMemoryAccessBuilder(
        physical,
        rangeResolver,
        loadStore,
        region
      )
    },
    effects: {
      reads: [pageTable.effect, ...physical.effects.reads],
      writes: physical.effects.writes
    }
  };
}

class VirtualMemoryAccessBuilder implements MemoryAccessOperations {
  readonly #physical: PhysicalAddressSpaceDefinition;
  readonly #rangeResolver: RangeResolver;
  readonly #loadStore: VirtualLoadStoreOperations;
  readonly #region: RegionBuilder;

  constructor(
    physical: PhysicalAddressSpaceDefinition,
    rangeResolver: RangeResolver,
    loadStore: VirtualLoadStoreOperations,
    region: RegionBuilder
  ) {
    this.#physical = physical;
    this.#rangeResolver = rangeResolver;
    this.#loadStore = loadStore;
    this.#region = region;
  }

  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent> {
    const region = this.#region;
    const values = region.values;
    const required = values.const(requiredEntryBits(intent));
    const resolution = this.#rangeResolver.resolve(
      region,
      range,
      required
    );
    const faultError = values.binary(
      "or",
      values.const(pageFaultErrorCode(intent)),
      resolution.deniedPresent
    );
    const physical = this.#physical.access.bind(region);

    return {
      access: {
        range,
        intent,
        scattered: resolution.scattered,
        physicalAccess: physical.issue({
          start: resolution.firstPhysicalStart,
          byteLength: range.byteLength
        })
      },
      fault: {
        condition: resolution.denied,
        exception: pageFault(resolution.deniedAddress, faultError)
      }
    };
  }

  load(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: MemoryLoadOptions = {}
  ): ValueId {
    return this.#loadStore.load(
      this.#region,
      access,
      byteOffset,
      width,
      options
    );
  }

  store(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void {
    this.#loadStore.store(
      this.#region,
      access,
      byteOffset,
      value,
      width
    );
  }
}

function requiredEntryBits(intent: MemoryAccessIntent): number {
  return intent === "write"
    ? pageTableEntryAttr.PRESENT | pageTableEntryAttr.WRITABLE
    : pageTableEntryAttr.PRESENT;
}
