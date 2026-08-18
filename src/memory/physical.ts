import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import {
  type ByteRange,
  type DynamicByteOrigin,
  type ResourceAccess,
  type ResourceEffect
} from "#compiler/function/resource.js";
import { resourceRef, type ResourceRef } from "#compiler/reference.js";
import type { Integer, I32Value } from "#compiler/function/values.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { wasmPageByteLength } from "#compiler/program/limits.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { readBackingByte } from "./bytes.js";
import { physicalRamResourceDefinition } from "./resource.js";

export type PhysicalRange = Readonly<{
  start: I32Value;
  byteLength: I32Value;
}>;

export type PhysicalAccess = Readonly<{
  range: PhysicalRange;
  origin: DynamicByteOrigin;
}>;

export type PhysicalTransferWidth = 8 | 16 | 32;

export type PhysicalAccessOperations = Readonly<{
  issue(range: PhysicalRange): PhysicalAccess;
  load<Width extends PhysicalTransferWidth>(
    access: PhysicalAccess,
    byteOffset: I32Value,
    width: Width
  ): Integer<Width>;
  store<Width extends PhysicalTransferWidth>(
    access: PhysicalAccess,
    byteOffset: I32Value,
    value: Integer<Width>
  ): void;
}>;

export type PhysicalAccessConstruction = Readonly<{
  forRegion(region: RegionBuilder): PhysicalAccessOperations;
}>;

export type PhysicalByteReader = Readonly<{
  readByte(address: number): number | undefined;
}>;

export type BoundPhysicalAddressSpace = Readonly<{
  reader: PhysicalByteReader;
}>;

export type PhysicalAddressSpaceDefinition = Readonly<{
  ramResource: ResourceRef;
  ramImport: MemoryImport;
  resources: readonly MemoryImport[];
  access: PhysicalAccessConstruction;
  effects: StorageEffects;
  bindHost(
    bindings: Readonly<{
      ram: WebAssembly.Memory;
    }>
  ): BoundPhysicalAddressSpace;
}>;

const physicalAddressSpaceByteLength = 0x1_0000_0000;

export function createPhysicalAddressSpaceDefinition(): PhysicalAddressSpaceDefinition {
  const ramResource = resourceRef(physicalRamResourceDefinition.id);
  const ramImport: MemoryImport = {
    ref: ramResource,
    moduleName: programImportModuleName,
    name: physicalRamResourceDefinition.name,
    limits: physicalRamResourceDefinition.limits
  };
  const ramEffect = wholeResourceEffect(ramResource);

  return {
    ramResource,
    ramImport,
    resources: [ramImport],
    access: {
      forRegion: (region) => new DirectRamAccessBuilder(ramResource, region)
    },
    effects: {
      reads: [ramEffect],
      writes: [ramEffect]
    },
    bindHost: ({ ram }) => bindPhysicalAddressSpace(ram, ramImport)
  };
}

function bindPhysicalAddressSpace(
  ram: WebAssembly.Memory,
  ramImport: MemoryImport
): BoundPhysicalAddressSpace {
  const minimumByteLength = ramImport.limits.minPages * wasmPageByteLength;

  if (ram.buffer.byteLength < minimumByteLength) {
    throw new RangeError(
      `physical RAM is too small: ${ram.buffer.byteLength} < ${minimumByteLength}`
    );
  }

  return {
    reader: {
      readByte: (address) => readBackingByte(ram, address)
    }
  };
}

class DirectRamAccessBuilder implements PhysicalAccessOperations {
  readonly #ramResource: ResourceRef;
  readonly #region: RegionBuilder;

  constructor(ramResource: ResourceRef, region: RegionBuilder) {
    this.#ramResource = ramResource;
    this.#region = region;
  }

  issue(range: PhysicalRange): PhysicalAccess {
    return {
      range,
      origin: Symbol("physical RAM access")
    };
  }

  load<Width extends PhysicalTransferWidth>(
    access: PhysicalAccess,
    byteOffset: I32Value,
    width: Width
  ): Integer<Width> {
    const region = this.#region;
    const source = physicalRamAccess(this.#ramResource, region, access, byteOffset, width);

    return region.readResource(source);
  }

  store<Width extends PhysicalTransferWidth>(
    access: PhysicalAccess,
    byteOffset: I32Value,
    value: Integer<Width>
  ): void {
    const region = this.#region;
    const destination = physicalRamAccess(
      this.#ramResource,
      region,
      access,
      byteOffset,
      value.width
    );

    region.writeResource(destination, value);
  }
}

function physicalRamAccess<Width extends PhysicalTransferWidth>(
  ramResource: ResourceRef,
  region: RegionBuilder,
  access: PhysicalAccess,
  byteOffset: I32Value,
  width: Width
): ResourceAccess<Width> {
  const byteLength = width / 8;
  const staticAccessByteLength = region.constValue(access.range.byteLength);
  const staticByteOffset = region.constValue(byteOffset);

  assert(
    staticByteOffset === undefined || staticByteOffset >= 0,
    `physical RAM byte offset must be non-negative, got ${String(staticByteOffset)}`
  );
  assert(
    staticByteOffset === undefined ||
      staticAccessByteLength === undefined ||
      staticByteOffset + byteLength <= staticAccessByteLength,
    `${width}-bit physical RAM access at byte offset ${String(staticByteOffset)} exceeds ${String(staticAccessByteLength)}-byte resolution`
  );
  const range = physicalRamRange(region, access, staticByteOffset, byteLength);
  const base =
    staticByteOffset === undefined ? access.range.start.add(byteOffset) : access.range.start;

  return {
    effect: { kind: "resource", resource: ramResource, range },
    address: {
      base,
      displacement: staticByteOffset ?? 0
    },
    storageWidth: width,
    valueWidth: width
  };
}

// A dynamic offset may select any byte in the issued access.
function physicalRamRange(
  region: RegionBuilder,
  access: PhysicalAccess,
  staticByteOffset: number | undefined,
  byteLength: number
): ByteRange {
  if (staticByteOffset === undefined) {
    return { kind: "whole", origin: access.origin };
  }
  const staticStart = region.constValue(access.range.start);

  if (staticStart !== undefined) {
    const absoluteStart = (staticStart >>> 0) + staticByteOffset;

    if (absoluteStart + byteLength <= physicalAddressSpaceByteLength) {
      return {
        kind: "slice",
        origin: "resource",
        byteOffset: absoluteStart,
        byteLength
      };
    }
  }

  return {
    kind: "slice",
    origin: access.origin,
    byteOffset: staticByteOffset,
    byteLength
  };
}

function wholeResourceEffect(resource: ResourceRef): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "whole", origin: "resource" }
  };
}
