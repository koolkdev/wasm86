import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { wasmPageByteLength } from "#compiler/program/limits.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { readBackingByte } from "./bytes.js";
import { physicalRamResourceDefinition } from "./resource.js";

export type PhysicalRange = Readonly<{
  start: ValueId;
  byteLength: ValueId;
}>;

export type PhysicalAccess = Readonly<{
  range: PhysicalRange;
  origin: DynamicByteOriginRef;
}>;

export type PhysicalLoadOptions = Readonly<{
  signed?: boolean;
}>;

export type PhysicalAccessOperations = Readonly<{
  issue(range: PhysicalRange): PhysicalAccess;
  load(
    access: PhysicalAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: PhysicalLoadOptions
  ): ValueId;
  store(
    access: PhysicalAccess,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
}>;

export type PhysicalAccessConstruction = Readonly<{
  bind(region: RegionBuilder): PhysicalAccessOperations;
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
  bindHost(bindings: Readonly<{
    ram: WebAssembly.Memory;
  }>): BoundPhysicalAddressSpace;
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
      bind: (region) => new DirectRamAccessBuilder(ramResource, region)
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
  const minimumByteLength =
    ramImport.limits.minPages * wasmPageByteLength;

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
      origin: new DynamicByteOriginRef()
    };
  }

  load(
    access: PhysicalAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: PhysicalLoadOptions = {}
  ): ValueId {
    const region = this.#region;
    const source = physicalRamOperand(
      this.#ramResource,
      region,
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
    access: PhysicalAccess,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void {
    const region = this.#region;
    const destination = physicalRamOperand(
      this.#ramResource,
      region,
      access,
      byteOffset,
      width
    );

    region.operation(resourceWrite, { destination, value });
  }
}

function physicalRamOperand(
  ramResource: ResourceRef,
  region: RegionBuilder,
  access: PhysicalAccess,
  byteOffset: ValueId,
  width: IntegerWidth
): ResourceByteOperand {
  assert(
    width === 8 || width === 16 || width === 32,
    `physical RAM operation width must be 8, 16, or 32, got ${String(width)}`
  );
  const byteLength = width / 8;
  const values = region.values;
  const staticAccessByteLength = values.constValue(access.range.byteLength);
  const staticByteOffset = values.constValue(byteOffset);

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
  const range = physicalRamRange(
    region,
    access,
    staticByteOffset,
    byteLength
  );
  const base = staticByteOffset === undefined
    ? values.binary("add", access.range.start, byteOffset)
    : access.range.start;

  return {
    effect: { space: "resource", resource: ramResource, range },
    address: {
      base,
      displacement: staticByteOffset ?? 0
    },
    width
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
    return { basis: { kind: "dynamic", origin: access.origin } };
  }
  const staticStart = region.values.constValue(access.range.start);

  if (staticStart !== undefined) {
    const absoluteStart = (staticStart >>> 0) + staticByteOffset;

    if (absoluteStart + byteLength <= physicalAddressSpaceByteLength) {
      return {
        basis: { kind: "resource" },
        slice: { byteOffset: absoluteStart, byteLength }
      };
    }
  }

  return {
    basis: { kind: "dynamic", origin: access.origin },
    slice: { byteOffset: staticByteOffset, byteLength }
  };
}

function wholeResourceEffect(resource: ResourceRef): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: { basis: { kind: "resource" } }
  };
}
