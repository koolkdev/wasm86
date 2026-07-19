import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body } from "./block.js";

// A child region as seen by generic IR consumers. Loop bodies additionally
// declare the values scoped to the loop's back edge.
export type NestedBody = Readonly<{
  body: Body;
  role: string;
  scope:
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{ kind: "loop"; inputs: readonly ValueId[] }>;
}>;

export type BodyCompletionContext = Readonly<{
  bodyCompletes: (body: Body) => boolean;
}>;

export type ValueUseEmitter = Readonly<{
  emitUse: (value: ValueId) => void;
}>;

// Operations and controls expose the same structural facts directly. Only
// context-dependent completion and structural rebuilding remain functions.
export interface BodyNodeBase {
  readonly kind: string;
  readonly operands: readonly ValueId[];
  readonly outputs: readonly ValueId[];
  readonly nestedBodies: readonly NestedBody[];
  readonly directEffects: StorageEffects;
  readonly completes: (context: BodyCompletionContext) => boolean;
}
