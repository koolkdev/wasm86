import type { StorageEffects } from "#compiler/ir/effects.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import {
  type PageFault
} from "#core/exceptions.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import {
  createFlatGuestMemoryReader,
  flatMemoryResolution
} from "./flat.js";
import {
  createPhysicalAddressSpaceDefinition,
  type PhysicalAccess,
  type PhysicalAccessOperations,
  type PhysicalAddressSpaceDefinition
} from "./physical.js";
import {
  createVirtualStorageDefinition,
  type VirtualStorageDefinition
} from "./virtual/storage.js";

export type LinearRange = Readonly<{
  start: ValueId;
  byteLength: ValueId;
}>;

export type MemoryDataAccessIntent = "read" | "write";
export type MemoryAccessIntent = MemoryDataAccessIntent | "instructionFetch";
export type MemoryReadIntent = Exclude<MemoryAccessIntent, "write">;

export type GuestMemoryByteRead =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{
      kind: "exception";
      exception: PageFault<number>;
    }>;

export type GuestMemoryReader = Readonly<{
  readByte(address: number, intent: MemoryReadIntent): GuestMemoryByteRead;
}>;

export type MemoryFault = Readonly<{
  condition: ValueId;
  exception: PageFault<ValueId>;
}>;

export type MemoryAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  range: LinearRange;
  intent: TIntent;
  physicalAccess: PhysicalAccess;
}>;

export type MemoryResolution<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  access: MemoryAccess<TIntent>;
  fault: MemoryFault;
}>;

export type MemoryLoadOptions = Readonly<{
  signed?: boolean;
}>;

export type MemoryAccessOperations = Readonly<{
  // Resolution is control-free. Its caller owns selecting the returned fault
  // before transferring through the access.
  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent>;
  // Loads and stores consume the access route without selecting its fault.
  load(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: MemoryLoadOptions
  ): ValueId;
  store(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
}>;

export type MemoryAccessConstruction = Readonly<{
  bind(region: RegionBuilder): MemoryAccessOperations;
}>;

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
