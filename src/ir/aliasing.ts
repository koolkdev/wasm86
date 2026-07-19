import type { Body, BodyNode } from "./block.js";
import type {
  StorageEffects,
  StorageAccess
} from "#compiler/ir/effects.js";
import {
  type ByteRange,
  type ResourceEffect
} from "#compiler/ir/resource.js";

// Compiler cells alias only their own opaque identity. Resource accesses use
// their resource identity plus the compiler-owned byte-range algebra.
// Distinct spaces never alias.

// A control's signature is the union over its bodies — any one may
// be selected. The union is for legality only; demand stays per-body.
export function effectsOf(node: BodyNode): StorageEffects {
  const direct = node.directEffects;
  const nested = bodyEffects(
    ...node.nestedBodies.map((entry) => entry.body)
  );

  return {
    reads: [...direct.reads, ...nested.reads],
    writes: [...direct.writes, ...nested.writes]
  };
}

function bodyEffects(...bodies: readonly Body[]): StorageEffects {
  const reads: StorageAccess[] = [];
  const writes: StorageAccess[] = [];

  for (const body of bodies) {
    for (const node of body.nodes) {
      const effects = effectsOf(node);

      reads.push(...effects.reads);
      writes.push(...effects.writes);
    }
  }

  return { reads, writes };
}

export function mayAlias(a: StorageAccess, b: StorageAccess): boolean {
  switch (a.space) {
    case "cell":
      return b.space === "cell" && a.cell === b.cell;
    case "resource":
      return b.space === "resource" && resourceEffectsMayAlias(a, b);
  }
}

// Is every location in `covered` also in `covering`?
export function covers(covering: StorageAccess, covered: StorageAccess): boolean {
  switch (covering.space) {
    case "cell":
      return covered.space === "cell" && covering.cell === covered.cell;
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

function resourceEffectCovers(
  covering: ResourceEffect,
  covered: ResourceEffect
): boolean {
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
  return outerStart <= innerStart &&
    innerStart + innerByteLength <= outerStart + outerByteLength;
}
