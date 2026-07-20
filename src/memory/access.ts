import { assert } from "#common/assert.js";
import type { DynamicByteOriginRef } from "#compiler/ir/resource.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import {
  pageFault,
  pageFaultErrorCode,
  type PageFault
} from "#core/exceptions.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import {
  flatMemoryAccess,
  flatMemoryOperand
} from "./flat.js";
import { readBackingByte } from "./bytes.js";
import { guestMemoryMinimumByteLength } from "./constants.js";

export type LinearRange = Readonly<{
  start: ValueId;
  byteLength: ValueId;
}>;

export type MemoryDataAccessIntent = "read" | "write";
export type MemoryAccessIntent = MemoryDataAccessIntent | "instructionFetch";

export type MemoryAccessFailure = Readonly<{
  condition: ValueId;
  exception: PageFault<ValueId>;
}>;

export type MemoryAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  range: LinearRange;
  origin: DynamicByteOriginRef;
  intent: TIntent;
  failure: MemoryAccessFailure;
}>;

export type MemoryReadOptions = Readonly<{
  signed?: boolean;
}>;

export type MemoryAccessOperations = Readonly<{
  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryAccess<TIntent>;
  read(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: MemoryReadOptions
  ): ValueId;
  write(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
}>;

export type HostMemoryByteAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  address: number;
  intent: TIntent;
}>;

export type HostMemoryByteResolution<TIntent extends MemoryAccessIntent> =
  | Readonly<{
      kind: "access";
      access: HostMemoryByteAccess<TIntent>;
    }>
  | Readonly<{
      kind: "exception";
      exception: PageFault<number>;
    }>;

export type HostMemoryAccessOperations = Readonly<{
  resolveByte<TIntent extends MemoryAccessIntent>(
    address: number,
    intent: TIntent
  ): HostMemoryByteResolution<TIntent>;
  readByte(access: HostMemoryByteAccess): number;
}>;

export type MemoryAccessConstruction = Readonly<{
  bind(region: RegionBuilder): MemoryAccessOperations;
}>;

export type MemoryModel = MemoryAccessConstruction & Readonly<{
  bindHost(memory: WebAssembly.Memory): HostMemoryAccessOperations;
}>;

export const guestMemoryAccess: MemoryModel = {
  bind: (region) => new FlatMemoryAccessBuilder(region),
  bindHost: (memory) => new FlatHostMemoryAccess(memory)
};

class FlatHostMemoryAccess implements HostMemoryAccessOperations {
  readonly #memory: WebAssembly.Memory;

  constructor(memory: WebAssembly.Memory) {
    assert(
      memory.buffer.byteLength >= guestMemoryMinimumByteLength,
      "guest memory is shorter than the flat address-space binding"
    );
    this.#memory = memory;
  }

  resolveByte<TIntent extends MemoryAccessIntent>(
    address: number,
    intent: TIntent
  ): HostMemoryByteResolution<TIntent> {
    assert(
      Number.isInteger(address) && address >= 0 && address <= 0xffff_ffff,
      `memory address must be u32, got ${address}`
    );

    return address < guestMemoryMinimumByteLength
      ? { kind: "access", access: { address, intent } }
      : {
          kind: "exception",
          exception: pageFault(
            address,
            pageFaultErrorCode(intent)
          )
        };
  }

  readByte(access: HostMemoryByteAccess): number {
    const value = readBackingByte(this.#memory, access.address);

    assert(
      value !== undefined,
      `resolved memory byte is absent at 0x${access.address.toString(16)}`
    );
    return value;
  }
}

class FlatMemoryAccessBuilder implements MemoryAccessOperations {
  readonly #region: RegionBuilder;

  constructor(region: RegionBuilder) {
    this.#region = region;
  }

  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    return flatMemoryAccess(this.#region.values, range, intent);
  }

  read(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: MemoryReadOptions = {}
  ): ValueId {
    const region = this.#region;
    const source = flatMemoryOperand(
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

  write(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void {
    const region = this.#region;
    const destination = flatMemoryOperand(
      region.values,
      access,
      byteOffset,
      width
    );

    region.operation(resourceWrite, { destination, value });
  }
}
