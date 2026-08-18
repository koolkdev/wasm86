import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { Integer, BitValue, I32Value } from "#compiler/function/values.js";
import type { PageFault } from "#core/exceptions.js";
import type { PhysicalAccess } from "./physical.js";

export type LinearRange = Readonly<{
  start: I32Value;
  byteLength: I32Value;
}>;

export type MemoryDataAccessIntent = "read" | "write";
export type MemoryAccessIntent = MemoryDataAccessIntent | "instructionFetch";
export type MemoryReadIntent = Exclude<MemoryAccessIntent, "write">;
export type MemoryTransferWidth = 8 | 16 | 32;

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
  condition: BitValue;
  exception: PageFault<I32Value>;
}>;

export type DirectMemoryAccess<TIntent extends MemoryAccessIntent = MemoryAccessIntent> = Readonly<{
  intent: TIntent;
  physicalAccess: PhysicalAccess;
}>;

export type DirectMemoryResolution<TIntent extends MemoryAccessIntent = MemoryAccessIntent> =
  Readonly<{
    unavailable: BitValue;
    access: DirectMemoryAccess<TIntent>;
  }>;

export type ResolvedMemoryAccess<TIntent extends MemoryAccessIntent = MemoryAccessIntent> =
  Readonly<{
    range: LinearRange;
    intent: TIntent;
    scattered: BitValue;
    physicalAccess: PhysicalAccess;
  }>;

export type MemoryResolution<TIntent extends MemoryAccessIntent = MemoryAccessIntent> = Readonly<{
  access: ResolvedMemoryAccess<TIntent>;
  fault: MemoryFault;
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
  load<Width extends MemoryTransferWidth>(
    access: ResolvedMemoryAccess,
    byteOffset: I32Value,
    width: Width
  ): Integer<Width>;
  loadDirect<Width extends MemoryTransferWidth>(
    access: DirectMemoryAccess,
    byteOffset: I32Value,
    width: Width
  ): Integer<Width>;
  store<Width extends MemoryTransferWidth>(
    access: ResolvedMemoryAccess<"write">,
    byteOffset: I32Value,
    value: Integer<Width>
  ): void;
  storeDirect<Width extends MemoryTransferWidth>(
    access: DirectMemoryAccess<"write">,
    byteOffset: I32Value,
    value: Integer<Width>
  ): void;
}>;

export type MemoryAccess = Readonly<{
  forRegion(region: RegionBuilder): BoundMemoryAccess;
  // The root must dominate every use of the returned access. Cached values
  // live for one invocation of that generated function.
  withCache(root: RegionBuilder): MemoryAccess;
}>;
