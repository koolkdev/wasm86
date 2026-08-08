import type { I32Value } from "#compiler/function/values.js";
import type { ResourceRef } from "#compiler/reference.js";

export type StorageWidth = 8 | 16 | 32 | 64;

type NarrowerValueWidths = Readonly<{
  8: 1;
  16: 1 | 8;
  32: 1 | 8 | 16;
  64: 1 | 8 | 16 | 32;
}>;

export type ValueWidthForStorage<Width extends StorageWidth> = Width | NarrowerValueWidths[Width];

export type DynamicByteOrigin = symbol;

type ByteRangeOrigin = "resource" | DynamicByteOrigin;

export type ByteRange =
  | Readonly<{ kind: "whole"; origin: ByteRangeOrigin }>
  | Readonly<{
      kind: "slice";
      origin: ByteRangeOrigin;
      byteOffset: number;
      byteLength: number;
    }>;

export type ResourceEffect = Readonly<{
  kind: "resource";
  resource: ResourceRef;
  range: ByteRange;
}>;

export type ResourceAccess<
  StoredWidth extends StorageWidth,
  ValueWidth extends ValueWidthForStorage<StoredWidth> = StoredWidth
> = Readonly<{
  effect: ResourceEffect;
  address: Readonly<{
    base: I32Value;
    displacement: number;
  }>;
  storageWidth: StoredWidth;
  valueWidth: ValueWidth;
}>;

export type AnyResourceAccess<StoredWidths extends StorageWidth = StorageWidth> = {
  readonly [StoredWidth in StoredWidths]: ResourceAccess<
    StoredWidth,
    ValueWidthForStorage<StoredWidth>
  >;
}[StoredWidths];
