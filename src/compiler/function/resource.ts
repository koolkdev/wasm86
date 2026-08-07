import type { ResourceRef } from "#compiler/reference.js";
import type { I32Value } from "#compiler/function/values.js";

export type StorageWidth = 8 | 16 | 32 | 64;

export type StoredIntegerWidth<Width extends StorageWidth> =
  | Width
  | 1
  | (Width extends 16 | 32 | 64 ? 8 : never)
  | (Width extends 32 | 64 ? 16 : never)
  | (Width extends 64 ? 32 : never);

declare const dynamicByteOriginRefBrand: unique symbol;

// Unique token shared by ranges based on the same dynamic address.
// The object's identity is the only data it needs.
export class DynamicByteOriginRef {
  declare readonly [dynamicByteOriginRefBrand]: true;
}

export type ByteRangeBasis =
  | Readonly<{ kind: "resource" }>
  | Readonly<{
      kind: "dynamic";
      origin: DynamicByteOriginRef;
    }>;

export type ByteSlice = Readonly<{
  byteOffset: number;
  byteLength: number;
}>;

// Coordinate basis and extent are independent. No slice means the entire
// basis; a slice is absolute for resource coordinates and relative for a
// dynamic origin.
export type ByteRange = Readonly<{
  basis: ByteRangeBasis;
  slice?: ByteSlice;
}>;

export type ResourceEffect = Readonly<{
  space: "resource";
  resource: ResourceRef;
  range: ByteRange;
}>;

type ResourceAccessShape<
  Base,
  Width extends StorageWidth,
  TValueWidth extends StoredIntegerWidth<Width>
> = Readonly<{
  effect: ResourceEffect;
  address: Readonly<{
    base: Base;
    displacement: number;
  }>;
  width: Width;
  valueWidth: TValueWidth;
}>;

// The address and width describe the byte transfer. The effect describes its
// aliasing, and valueWidth is the scalar contract carried by the storage.
export type ResourceAccess<
  Width extends StorageWidth,
  TValueWidth extends StoredIntegerWidth<Width> = Width
> = ResourceAccessShape<I32Value, Width, TValueWidth>;

type AnyResourceAccessShape<Base, Widths extends StorageWidth = StorageWidth> = {
  readonly [Width in Widths]: ResourceAccessShape<Base, Width, StoredIntegerWidth<Width>>;
}[Widths];

export type AnyResourceAccess<Widths extends StorageWidth = StorageWidth> = AnyResourceAccessShape<
  I32Value,
  Widths
>;

export type ResourceAccessNode = AnyResourceAccessShape<I32Value>;
