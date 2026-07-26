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

export type DirectMemoryAccess<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  intent: TIntent;
  physicalAccess: PhysicalAccess;
}>;

export type DirectMemoryResolution<
  TIntent extends MemoryAccessIntent = MemoryAccessIntent
> = Readonly<{
  unavailable: ValueId;
  access: DirectMemoryAccess<TIntent>;
}>;

export type ResolvedMemoryAccess<
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
  access: ResolvedMemoryAccess<TIntent>;
  fault: MemoryFault;
}>;

export type MemoryLoadOptions = Readonly<{
  signed?: boolean;
}>;

export type BoundMemoryAccess = Readonly<{
  // Callers must select the returned fault before using its access.
  resolve<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): MemoryResolution<TIntent>;
  // This does not raise a memory fault. The direct access is usable only when
  // `unavailable` is zero.
  resolveDirect<TIntent extends MemoryAccessIntent>(
    range: LinearRange,
    intent: TIntent
  ): DirectMemoryResolution<TIntent>;
  load(
    access: ResolvedMemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: MemoryLoadOptions
  ): ValueId;
  loadDirect(
    access: DirectMemoryAccess,
    byteOffset: ValueId,
    width: IntegerWidth,
    options?: MemoryLoadOptions
  ): ValueId;
  store(
    access: ResolvedMemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
  storeDirect(
    access: DirectMemoryAccess<"write">,
    byteOffset: ValueId,
    value: ValueId,
    width: IntegerWidth
  ): void;
}>;

export type MemoryAccess = Readonly<{
  bind(region: RegionBuilder): BoundMemoryAccess;
  // The root must dominate every use of the returned access. Cached values
  // live for one invocation of that generated function.
  withCache(root: RegionBuilder): MemoryAccess;
}>;
