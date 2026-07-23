import {
  noStorageEffects,
  type StorageEffects
} from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "#compiler/ir/region.js";
import type {
  RegionCompletionContext,
  RegionNodeBase,
  NestedRegion
} from "#compiler/ir/node.js";

export type BranchHint = "unlikely" | "likely";

// A control is one final node with shared region facts. Concrete control types
// add their semantic fields; the Wasm backend owns their realization.
export abstract class ControlBase implements RegionNodeBase {
  readonly category = "control";
  readonly directEffects: StorageEffects = noStorageEffects;

  abstract readonly kind: string;
  abstract readonly operands: readonly ValueId[];
  abstract readonly outputs: readonly ValueId[];
  abstract readonly nestedBodies: readonly NestedRegion[];
  abstract completes(context: RegionCompletionContext): boolean;
  abstract mapBodies(map: (body: Region) => Region): ControlBase;
}

export abstract class TerminalControlBase extends ControlBase {
  readonly outputs: readonly [] = [];
  readonly nestedBodies: readonly [] = [];

  completes(_context: RegionCompletionContext): true {
    return true;
  }

  mapBodies(_map: (body: Region) => Region): this {
    return this;
  }
}
