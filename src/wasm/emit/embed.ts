import type { ValueId } from "#ir/values.js";

// A fragment is an IrBlock emitted inline into a hand-written function
// body. The embedding never changes the block — it only decides what the
// emitter does where the block completes.

export type FallthroughCompletion = Readonly<{ kind: "fallthrough" }>;

// The depth counts from the fragment's insertion point; the emitter adds
// its own nesting.
export type BrCompletion = Readonly<{ kind: "br"; depth: number }>;

// The runtime's indirect link table: a slot per external target.
export type LinkTable = Readonly<{
  slotFor(targetEip: number): number | undefined;
  typeIndex: number;
  tableIndex: number;
}>;

// A constant continuation tail-calls its target's function or table slot;
// a dynamic one reports DYNAMIC_JUMP.
export type LinkCompletion = Readonly<{
  kind: "link";
  // Same-module target -> its function index.
  functionFor(targetEip: number): number | undefined;
  table?: LinkTable;
}>;

// An open completion lands in embedder code; a closed one leaves the
// function itself, so it works anywhere.
export type OpenCompletion = FallthroughCompletion | BrCompletion;
export type ClosedCompletion = LinkCompletion;
export type CompletionPolicy = OpenCompletion | ClosedCompletion;

export type FragmentEmbedding = Readonly<{
  // Where a completed block lands. Exits always return the encoded i64
  // report, payload included.
  completion: CompletionPolicy;
  // Value -> embedder local, set right before the entry terminator.
  outputs?: ReadonlyMap<ValueId, number>;
}>;

// No embedder code to land in: the completion must close the function.
export type FunctionEmbedding = Readonly<{ completion: ClosedCompletion }>;
