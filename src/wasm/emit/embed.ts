import type { ValueId } from "#compiler/ir/values/types.js";

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

// A constant dispatch target tail-calls its target's function or table slot;
// a dynamic one reports DYNAMIC_JUMP.
export type LinkCompletion = Readonly<{
  kind: "link";
  // Same-module target -> its function index.
  functionFor(targetEip: number): number | undefined;
  table?: LinkTable;
}>;

export type FallthroughTarget = FallthroughCompletion | BrCompletion;
export type DispatchTarget = BrCompletion | LinkCompletion;

export type ActionEmbedding = Readonly<{
  // Where dispatch(targetEip) lands. Exits always return the encoded i64
  // report, payload included.
  dispatch?: DispatchTarget;
  // Where an action body with no terminator lands.
  fallthrough?: FallthroughTarget;
  // Value -> embedder local, set at the action body boundary.
  outputs?: ReadonlyMap<ValueId, number>;
}>;

export type FragmentEmbedding = ActionEmbedding;
export type FunctionEmbedding = Readonly<{ dispatch: LinkCompletion }>;
