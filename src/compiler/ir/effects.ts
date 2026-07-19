import type { CellRef } from "#compiler/refs/cell.js";
import type { ResourceEffect } from "./resource.js";

export type StorageAccess =
  | Readonly<{ space: "cell"; cell: CellRef }>
  | ResourceEffect;

export type StorageEffects = Readonly<{
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;

export const noStorageEffects: StorageEffects = { reads: [], writes: [] };
