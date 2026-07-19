import type { DynamicByteOriginRef } from "#compiler/ir/resource.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import {
  flatMemoryAccess,
  flatMemoryOperand
} from "./flat.js";

export type LinearRange = Readonly<{
  start: ValueId;
  byteLength: ValueId;
}>;

export type MemoryDataAccessIntent = "read" | "write";
export type MemoryAccessIntent = MemoryDataAccessIntent | "instructionFetch";

export type MemoryAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  range: LinearRange;
  origin: DynamicByteOriginRef;
  faulted: ValueId;
  fault: Readonly<{
    address: ValueId;
    intent: TIntent;
  }>;
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

export type MemoryAccessConstruction = Readonly<{
  bind(region: RegionBuilder): MemoryAccessOperations;
}>;

export const guestMemoryAccess: MemoryAccessConstruction = {
  bind: (region) => new FlatMemoryAccessBuilder(region)
};

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
