import type { ActionExitReason } from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";

// A fragment is an ActionBlock emitted inline into a hand-written function
// body. The embedding never changes the block — it only decides what the
// emitter does when the block exits.

// How a rerouted exit leaves the fragment instead of returning the encoded
// i64 exit. A "br" depth counts from the fragment's insertion point; the
// emitter adds its own nesting.
export type ExitReroute =
  | Readonly<{ kind: "fallthrough" }>
  | Readonly<{ kind: "br"; depth: number }>;

export type ActionEmbedding = Readonly<{
  // Where a completed block (exit next or jump, eip already flushed)
  // continues. Every other exit is a report to the host and returns the
  // encoded i64, payload included.
  success?: ExitReroute;
  // Value -> embedder local, set right before the entry terminator.
  outputs?: ReadonlyMap<ValueId, number>;
}>;

export function exitRerouteOf(
  embedding: ActionEmbedding,
  reason: ActionExitReason
): ExitReroute | undefined {
  switch (reason) {
    case "next":
    case "jump":
      return embedding.success;
    case "hostTrap":
    case "unsupported":
    case "decodeFault":
    case "memoryReadFault":
    case "memoryWriteFault":
      return undefined;
  }
}
