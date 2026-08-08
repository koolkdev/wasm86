import type { ResourceEffect } from "#compiler/function/resource.js";
import type { ValueType } from "#compiler/function/values.js";

export class VariableRef<Type extends ValueType = ValueType> {
  readonly kind = "variable";

  constructor(readonly type: Type) {}
}

export type StorageAccess = VariableRef | ResourceEffect;

export type StorageEffects = Readonly<{
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;

export const noStorageEffects: StorageEffects = { reads: [], writes: [] };

export function mayAlias(left: StorageAccess, right: StorageAccess): boolean {
  if (left.kind === "variable" || right.kind === "variable") {
    return left === right;
  }
  if (left.resource !== right.resource) {
    return false;
  }

  const leftRange = left.range;
  const rightRange = right.range;

  if (
    leftRange.origin !== rightRange.origin ||
    leftRange.kind === "whole" ||
    rightRange.kind === "whole"
  ) {
    return true;
  }

  return (
    leftRange.byteOffset < rightRange.byteOffset + rightRange.byteLength &&
    rightRange.byteOffset < leftRange.byteOffset + leftRange.byteLength
  );
}

export function covers(covering: StorageAccess, covered: StorageAccess): boolean {
  if (covering.kind === "variable" || covered.kind === "variable") {
    return covering === covered;
  }
  if (covering.resource !== covered.resource) {
    return false;
  }

  const outer = covering.range;
  const inner = covered.range;

  if (outer.kind === "whole") {
    return outer.origin === "resource" || outer.origin === inner.origin;
  }
  if (inner.kind === "whole" || outer.origin !== inner.origin) {
    return false;
  }

  return (
    outer.byteOffset <= inner.byteOffset &&
    inner.byteOffset + inner.byteLength <= outer.byteOffset + outer.byteLength
  );
}
