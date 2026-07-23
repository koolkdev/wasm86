import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "./region.js";

// A child region as seen by generic IR consumers. Loop bodies additionally
// declare the values scoped to the loop's back edge.
export type NestedRegion = Readonly<{
  body: Region;
  role: string;
  scope:
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{ kind: "loop"; inputs: readonly ValueId[] }>;
}>;

export type RegionCompletionContext = Readonly<{
  regionCompletes: (body: Region) => boolean;
}>;

// Operations and controls expose the same structural facts directly. Only
// context-dependent completion and structural rebuilding remain functions.
export interface RegionNodeBase {
  readonly kind: string;
  readonly operands: readonly ValueId[];
  readonly outputs: readonly ValueId[];
  readonly nestedBodies: readonly NestedRegion[];
  readonly directEffects: StorageEffects;
  readonly completes: (context: RegionCompletionContext) => boolean;
}
