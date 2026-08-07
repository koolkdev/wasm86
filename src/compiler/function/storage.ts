import type { ByteRange, ResourceEffect } from "#compiler/function/resource.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";

// Function-local mutable storage identity. It is distinct by object identity;
// source validation gives it structural scope through its seed write.
export class VariableRef<Width extends IntegerWidth = IntegerWidth> {
  readonly kind = "variable";

  constructor(readonly width: Width) {}
}

export type StorageAccess = Readonly<{ space: "variable"; variable: VariableRef }> | ResourceEffect;

export type StorageEffects = Readonly<{
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;

export const noStorageEffects: StorageEffects = { reads: [], writes: [] };

// Variables alias only their own opaque identity. Resource accesses use their
// resource identity plus the byte-range algebra. Distinct storage spaces never
// alias.
export function mayAlias(a: StorageAccess, b: StorageAccess): boolean {
  switch (a.space) {
    case "variable":
      return b.space === "variable" && a.variable === b.variable;
    case "resource":
      return b.space === "resource" && resourceEffectsMayAlias(a, b);
  }
}

// Is every location in `covered` also in `covering`?
export function covers(covering: StorageAccess, covered: StorageAccess): boolean {
  switch (covering.space) {
    case "variable":
      return covered.space === "variable" && covering.variable === covered.variable;
    case "resource":
      return covered.space === "resource" && resourceEffectCovers(covering, covered);
  }
}

function resourceEffectsMayAlias(a: ResourceEffect, b: ResourceEffect): boolean {
  if (a.resource !== b.resource) {
    return false;
  }
  return byteRangesMayAlias(a.range, b.range);
}

function resourceEffectCovers(covering: ResourceEffect, covered: ResourceEffect): boolean {
  if (covering.resource !== covered.resource) {
    return false;
  }
  return byteRangeCovers(covering.range, covered.range);
}

function byteRangesMayAlias(a: ByteRange, b: ByteRange): boolean {
  if (isWholeResource(a) || isWholeResource(b)) {
    return true;
  }
  if (!sameByteRangeBasis(a, b)) {
    return true;
  }
  if (a.slice === undefined || b.slice === undefined) {
    return true;
  }
  return intervalsOverlap(
    a.slice.byteOffset,
    a.slice.byteLength,
    b.slice.byteOffset,
    b.slice.byteLength
  );
}

function byteRangeCovers(covering: ByteRange, covered: ByteRange): boolean {
  if (isWholeResource(covering)) {
    return true;
  }
  if (!sameByteRangeBasis(covering, covered)) {
    return false;
  }
  if (covering.slice === undefined) {
    return true;
  }
  if (covered.slice === undefined) {
    return false;
  }
  return intervalContains(
    covering.slice.byteOffset,
    covering.slice.byteLength,
    covered.slice.byteOffset,
    covered.slice.byteLength
  );
}

function isWholeResource(range: ByteRange): boolean {
  return range.basis.kind === "resource" && range.slice === undefined;
}

function sameByteRangeBasis(a: ByteRange, b: ByteRange): boolean {
  if (a.basis.kind === "resource") {
    return b.basis.kind === "resource";
  }
  return b.basis.kind === "dynamic" && a.basis.origin === b.basis.origin;
}

function intervalsOverlap(
  aStart: number,
  aByteLength: number,
  bStart: number,
  bByteLength: number
): boolean {
  return aStart < bStart + bByteLength && bStart < aStart + aByteLength;
}

function intervalContains(
  outerStart: number,
  outerByteLength: number,
  innerStart: number,
  innerByteLength: number
): boolean {
  return outerStart <= innerStart && innerStart + innerByteLength <= outerStart + outerByteLength;
}
