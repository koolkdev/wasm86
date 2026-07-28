import type { IntegerWidth, ValueId, WidthBounds } from "#compiler/ir/values/types.js";

declare const resourceRefBrand: unique symbol;

// Resource identity is normalized IR vocabulary: operations and effects
// compare it directly. Program assembly registers and resolves the identity
// but does not define its equality.
export type ResourceRef = Readonly<{
  [resourceRefBrand]: "resource";
  kind: "resource";
  id: string;
}>;

export function resourceRef(id: string): ResourceRef {
  if (id.length === 0) {
    throw new Error("empty resource identity");
  }

  return { kind: "resource", id } as ResourceRef;
}

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

// One owner-issued byte operand. The effect is the conservative analysis
// fact; the address is executable base-plus-constant form; width is the exact
// transfer size. Dynamic address terms are ordinary scalar values in `base`.
export type ResourceByteOperand = Readonly<{
  effect: ResourceEffect;
  address: Readonly<{
    base: ValueId;
    displacement: number;
  }>;
  width: IntegerWidth;
}>;

// Result interpretation for a resource read. Omitting the mode means an
// unsigned read bounded only by the transfer width.
export type ResourceReadMode =
  Readonly<{ kind: "signed" }> | Readonly<{ kind: "unsigned"; bounds?: WidthBounds }>;
