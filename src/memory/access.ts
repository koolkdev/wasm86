import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type { DynamicByteOriginRef } from "#compiler/ir/resource.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
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
  invalid: ValueId;
  fault: Readonly<{
    address: ValueId;
    intent: TIntent;
  }>;
}>;

type MemoryAccessBuilderOptions = Readonly<{
  values: ValueTable;
  currentBody(): Pick<RegionBuilder, "operation">;
}>;

type MemoryReadOptions = Readonly<{
  signed?: boolean;
}>;

export class MemoryAccessBuilder {
  readonly #values: ValueTable;
  readonly #currentBody: () => Pick<RegionBuilder, "operation">;

  constructor(options: MemoryAccessBuilderOptions) {
    this.#values = options.values;
    this.#currentBody = options.currentBody;
  }

  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    return flatMemoryAccess(this.#values, range, intent);
  }

  read(
    access: MemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options: MemoryReadOptions = {}
  ): ValueId {
    const source = flatMemoryOperand(
      this.#values,
      access,
      byteOffset,
      width
    );
    const signed = options.signed === true && width !== 32;

    return this.#currentBody().operation(
      resourceRead.create(signed ? { source, signed: true } : { source })
    );
  }

  write(
    access: MemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void {
    const destination = flatMemoryOperand(
      this.#values,
      access,
      byteOffset,
      width
    );

    this.#currentBody().operation(
      resourceWrite.create({ destination, value })
    );
  }
}
