import type { CellRef } from "#compiler/refs/cell.js";
import type { StateSlot } from "#ir/slots.js";

export type StorageAccess =
  | Readonly<{ space: "state"; slot: StateSlot }>
  | Readonly<{ space: "memory" }>
  | Readonly<{ space: "memoryBounds" }>
  | Readonly<{ space: "cell"; cell: CellRef }>;

export type StorageEffects = Readonly<{
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;
