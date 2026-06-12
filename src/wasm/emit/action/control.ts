import { assert } from "#common/assert.js";
import type {
  Action,
  ActionExitReason,
  ContinueAction,
  EdgeRegion,
  ExitAction,
  RegionId
} from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import type { CompletionPolicy } from "./embed.js";

// Edge-region encoding and terminator emission.

export type ControlFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  edges: readonly EdgeRegion[];
  // The entry region's terminator.
  terminator: Action;
  // Where a completed block lands; never a host return.
  completion: CompletionPolicy;
  // Pushes an exit payload value; the frame never touches the value layer
  // otherwise.
  emitPayload(id: ValueId): void;
}>;

export type ControlFrame = Readonly<{
  // Label depth of the edge's block as seen from entry code.
  depthOf(edge: RegionId): number;
  // Emits the terminator at the current emission point; detail is the
  // guard's byte length on fault edges.
  emitTerminator(terminator: ExitAction | ContinueAction, detail?: number): void;
  run(emitEntry: () => void, emitEdgeBody: (edge: EdgeRegion) => void): void;
}>;

// One frame per emission. Edge regions encode as wasm blocks: a guard or
// branch br_ifs to its edge's label, and the edge body sits right after that
// block's end — the first edge is innermost, so an edge's label depth from
// the entry code is its position in nest order. The fall-through edge nests
// first: entry code that ends without branching runs past the innermost end
// into its body. Regions end with a terminator, so nothing falls through
// between bodies.
export function createControlFrame(context: ControlFrameContext): ControlFrame {
  const { body, terminator, completion } = context;
  const nested = nestOrder(context.edges, terminator.kind === "branch" ? terminator.notTaken : undefined);
  const depths = new Map<RegionId, number>(nested.map((edge, index) => [edge.id, index]));
  const wrapped = needsFallthroughWrapper(nested, terminator, completion);
  // Edge blocks still open around the current emission point.
  let openEdgeBlocks = nested.length;

  function emitTerminator(action: ExitAction | ContinueAction, detail = 0): void {
    switch (action.kind) {
      case "exit":
        emitReport(action, detail);
        return;
      case "continue":
        emitCompletion();
        return;
    }
  }

  function emitCompletion(): void {
    switch (completion.kind) {
      case "fallthrough":
        // Past the remaining edge bodies to the wrapper's end; with none
        // left the fragment's code simply ends here.
        if (openEdgeBlocks > 0) {
          assert(wrapped, "a non-final fallthrough completion needs the wrapper block");
          body.br(openEdgeBlocks);
        }

        return;
      case "br":
        body.br(completion.depth + openEdgeBlocks + (wrapped ? 1 : 0));
        return;
    }
  }

  function emitReport(exit: ExitAction, detail: number): void {
    const reason = exitReasonCode(exit.reason);

    if (exit.payload === undefined) {
      body.i64Const(encodeExit(reason, 0, detail)).returnFromFunction();
      return;
    }

    context.emitPayload(exit.payload);
    body.i64ExtendI32U().i64Const(encodeExit(reason, 0, detail)).i64Or().returnFromFunction();
  }

  return {
    depthOf(edge: RegionId): number {
      const depth = depths.get(edge);

      assert(depth !== undefined, `no edge region ${edge} in this block`);
      return depth;
    },
    emitTerminator,
    run(emitEntry: () => void, emitEdgeBody: (edge: EdgeRegion) => void): void {
      if (wrapped) {
        body.block();
      }

      for (let index = 0; index < nested.length; index += 1) {
        body.block();
      }

      emitEntry();

      for (const edge of nested) {
        body.endBlock();
        openEdgeBlocks -= 1;
        emitEdgeBody(edge);
      }

      if (wrapped) {
        body.endBlock();
      }
    }
  };
}

// A fallthrough completion emitted while later edge bodies remain must
// branch past them, so the fragment wraps itself in one block whose end is
// the fall-through target. The last edge body — and the terminator of an
// edge-less block — already falls out of the fragment directly.
function needsFallthroughWrapper(
  nested: readonly EdgeRegion[],
  terminator: Action,
  completion: CompletionPolicy
): boolean {
  if (completion.kind !== "fallthrough") {
    return false;
  }

  if (terminator.kind === "continue" && nested.length > 0) {
    return true;
  }

  return nested.some(
    (edge, index) => index < nested.length - 1 && edge.terminator.kind === "continue"
  );
}

function nestOrder(edges: readonly EdgeRegion[], fallthroughEdge: RegionId | undefined): readonly EdgeRegion[] {
  if (fallthroughEdge === undefined) {
    return edges;
  }

  const fallthrough = edges.find((edge) => edge.id === fallthroughEdge);

  assert(fallthrough !== undefined, `no edge region ${fallthroughEdge} in this block`);
  return [fallthrough, ...edges.filter((edge) => edge !== fallthrough)];
}

// ir/action names exit reasons; the emitter owns the numeric encoding.
function exitReasonCode(reason: ActionExitReason): ExitReason {
  switch (reason) {
    case "hostTrap":
      return ExitReason.HOST_TRAP;
    case "unsupported":
      return ExitReason.UNSUPPORTED;
    case "decodeFault":
      return ExitReason.DECODE_FAULT;
    case "memoryReadFault":
      return ExitReason.MEMORY_READ_FAULT;
    case "memoryWriteFault":
      return ExitReason.MEMORY_WRITE_FAULT;
  }
}
