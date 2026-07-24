import type { StorageEffects } from "#compiler/ir/effects.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import {
  createFlatGuestMemoryReader,
  flatMemoryResolution
} from "./flat.js";
import {
  createPhysicalAddressSpaceDefinition,
  type PhysicalAccessOperations,
  type PhysicalAddressSpaceDefinition
} from "./physical.js";
import type {
  GuestMemoryReader,
  LinearRange,
  MemoryAccess,
  MemoryAccessConstruction,
  MemoryAccessIntent,
  MemoryAccessOperations,
  MemoryLoadOptions,
  MemoryResolution
} from "./types.js";
import {
  createVirtualStorageDefinition,
  type VirtualStorageDefinition
} from "./virtual/storage.js";

export type {
  GuestMemoryByteRead,
  GuestMemoryReader,
  LinearRange,
  MemoryAccess,
  MemoryAccessConstruction,
  MemoryAccessIntent,
  MemoryAccessOperations,
  MemoryDataAccessIntent,
  MemoryFault,
  MemoryLoadOptions,
  MemoryReadIntent,
  MemoryResolution
} from "./types.js";

export type BoundMemory = Readonly<{
  reader: GuestMemoryReader;
}>;

export type MemoryDefinition = Readonly<{
  physical: PhysicalAddressSpaceDefinition;
  virtualStorage: VirtualStorageDefinition;
  resources: readonly MemoryImport[];
  access: MemoryAccessConstruction;
  effects: StorageEffects;
  bindHost(bindings: Readonly<{
    ram: WebAssembly.Memory;
  }>): BoundMemory;
}>;

export function createMemoryDefinition(): MemoryDefinition {
  const physical = createPhysicalAddressSpaceDefinition();
  const virtualStorage = createVirtualStorageDefinition();

  return {
    physical,
    virtualStorage,
    resources: [...physical.resources, ...virtualStorage.resources],
    access: {
      bind: (region) => new FlatMemoryAccessBuilder(
        physical.access.bind(region),
        region
      )
    },
    effects: physical.effects,
    bindHost: ({ ram }) => ({
      reader: createFlatGuestMemoryReader(
        physical.bindHost({ ram }).reader
      )
    })
  };
}

class FlatMemoryAccessBuilder implements MemoryAccessOperations {
  readonly #physical: PhysicalAccessOperations;
  readonly #region: RegionBuilder;

  constructor(
    physical: PhysicalAccessOperations,
    region: RegionBuilder
  ) {
    this.#physical = physical;
    this.#region = region;
  }

  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent> {
    return flatMemoryResolution(
      this.#region.values,
      range,
      intent,
      this.#physical.issue(range)
    );
  }

  load(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: MemoryLoadOptions = {}
  ): ValueId {
    return this.#physical.load(
      access.physicalAccess,
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
    this.#physical.store(
      access.physicalAccess,
      byteOffset,
      value,
      width
    );
  }
}
