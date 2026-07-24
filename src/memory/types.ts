import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import type { PageFault } from "#core/exceptions.js";
import type { PhysicalAccess } from "./physical.js";

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
  scattered: ValueId;
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
  // Callers must select the returned fault before using its access.
  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent>;
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
