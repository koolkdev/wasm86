import { assert } from "#common/assert.js";
import {
  resourceRef,
  type DynamicByteOriginRef,
  type ResourceRef
} from "#compiler/ir/resource.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import {
  pageFault,
  pageFaultErrorCode,
  type PageFault
} from "#core/exceptions.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import {
  flatMemoryOperand,
  flatMemoryResolution
} from "./flat.js";
import { readBackingByte } from "./bytes.js";
import { guestMemoryMinimumByteLength } from "./constants.js";
import { guestMemoryResourceDefinition } from "./resource.js";

export type LinearRange = Readonly<{
  start: ValueId;
  byteLength: ValueId;
}>;

export type MemoryDataAccessIntent = "read" | "write";
export type MemoryAccessIntent = MemoryDataAccessIntent | "instructionFetch";
export type MemoryReadIntent = Exclude<MemoryAccessIntent, "write">;

export type MemoryFault = Readonly<{
  condition: ValueId;
  exception: PageFault<ValueId>;
}>;

export type MemoryAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  range: LinearRange;
  origin: DynamicByteOriginRef;
  intent: TIntent;
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

export type GuestMemoryByteRead =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{
      kind: "exception";
      exception: PageFault<number>;
    }>;

export type GuestMemoryReader = Readonly<{
  readByte(address: number, intent: MemoryReadIntent): GuestMemoryByteRead;
}>;

export type MemoryAccessConstruction = Readonly<{
  bind(region: RegionBuilder): MemoryAccessOperations;
}>;

export type GuestMemoryDefinition = Readonly<{
  resource: ResourceRef;
  access: MemoryAccessConstruction;
  createReader(memory: WebAssembly.Memory): GuestMemoryReader;
  memoryImport: MemoryImport;
}>;

export function createGuestMemoryDefinition(): GuestMemoryDefinition {
  const resource = resourceRef(guestMemoryResourceDefinition.id);

  return {
    resource,
    access: {
      bind: (region) => new FlatMemoryAccessBuilder(resource, region)
    },
    createReader: (memory) => new FlatGuestMemoryReader(memory),
    memoryImport: {
      ref: resource,
      moduleName: programImportModuleName,
      name: guestMemoryResourceDefinition.name,
      limits: guestMemoryResourceDefinition.limits
    }
  };
}

class FlatGuestMemoryReader implements GuestMemoryReader {
  readonly #memory: WebAssembly.Memory;

  constructor(memory: WebAssembly.Memory) {
    assert(
      memory.buffer.byteLength >= guestMemoryMinimumByteLength,
      "guest memory is shorter than the flat address-space binding"
    );
    this.#memory = memory;
  }

  readByte(address: number, intent: MemoryReadIntent): GuestMemoryByteRead {
    assert(
      Number.isInteger(address) && address >= 0 && address <= 0xffff_ffff,
      `memory address must be u32, got ${address}`
    );

    if (address >= guestMemoryMinimumByteLength) {
      return {
        kind: "exception",
        exception: pageFault(address, pageFaultErrorCode(intent))
      };
    }
    const value = readBackingByte(this.#memory, address);

    assert(
      value !== undefined,
      `checked memory byte is absent at address ${address}`
    );
    return { kind: "value", value };
  }
}

class FlatMemoryAccessBuilder implements MemoryAccessOperations {
  readonly #resource: ResourceRef;
  readonly #region: RegionBuilder;

  constructor(resource: ResourceRef, region: RegionBuilder) {
    this.#resource = resource;
    this.#region = region;
  }

  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent> {
    return flatMemoryResolution(this.#region.values, range, intent);
  }

  load(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: MemoryLoadOptions = {}
  ): ValueId {
    const region = this.#region;
    const source = flatMemoryOperand(
      this.#resource,
      region.values,
      access,
      byteOffset,
      width
    );
    const signed = options.signed === true && width !== 32;

    return region.operation(
      resourceRead,
      signed
        ? { source, mode: { kind: "signed" } }
        : { source }
    );
  }

  store(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void {
    const region = this.#region;
    const destination = flatMemoryOperand(
      this.#resource,
      region.values,
      access,
      byteOffset,
      width
    );

    region.operation(resourceWrite, { destination, value });
  }
}
