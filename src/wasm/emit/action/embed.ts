import type { ValueId } from "#ir/action/values.js";

// A fragment is an ActionBlock emitted inline into a hand-written function
// body. The embedding never changes the block — it only decides what the
// emitter does where the block completes.

// How a continue leaves the fragment. A "br" depth counts from the
// fragment's insertion point; the emitter adds its own nesting.
export type CompletionPolicy =
  | Readonly<{ kind: "fallthrough" }>
  | Readonly<{ kind: "br"; depth: number }>;

export type ActionEmbedding = Readonly<{
  // Where a completed block lands. Exits always return the encoded i64
  // report, payload included.
  completion: CompletionPolicy;
  // Value -> embedder local, set right before the entry terminator.
  outputs?: ReadonlyMap<ValueId, number>;
}>;
