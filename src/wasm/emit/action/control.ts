import { assert } from "#common/assert.js";
import type { Action, ActionExitReason, EdgeRegion, ExitAction, RegionId } from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import type { ExitReroute } from "./embed.js";

// Edge-region encoding and exit lowering.

export type ControlFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  edges: readonly EdgeRegion[];
  // The entry region's terminator.
  terminator: Action;
  exitReroute(reason: ActionExitReason): ExitReroute | undefined;
  // Pushes an exit payload value; the frame never touches the value layer
  // otherwise.
  emitPayload(id: ValueId): void;
}>;

export type ControlFrame = Readonly<{
  // Label depth of the edge's block as seen from entry code.
  depthOf(edge: RegionId): number;
  // Lowers the exit at the current emission point; detail is the guard's
  // byte length on fault edges.
  emitExit(exit: ExitAction, detail?: number): void;
  run(emitEntry: () => void, emitEdgeBody: (edge: EdgeRegion) => void): void;
}>;

// One frame per emission. Edge regions encode as wasm blocks: a guard or
// branch br_ifs to its edge's label, and the edge body sits right after that
// block's end — the first edge is innermost, so an edge's label depth from
// the entry code is its position in nest order. The fall-through edge nests
// first: entry code that ends without branching runs past the innermost end
// into its body. Regions end with an exit, so nothing falls through between
// bodies.
export function createControlFrame(context: ControlFrameContext): ControlFrame {
  const { body, terminator, exitReroute } = context;
  const nested = nestOrder(context.edges, terminator.kind === "branch" ? terminator.notTaken : undefined);
  const depths = new Map<RegionId, number>(nested.map((edge, index) => [edge.id, index]));
  const wrapped = needsFallthroughWrapper(nested, terminator, exitReroute);
  // Edge blocks still open around the current emission point.
  let openEdgeBlocks = nested.length;

  function emitExit(exit: ExitAction, detail = 0): void {
    const reroute = exitReroute(exit.reason);

    if (reroute === undefined) {
      emitReturn(exit, detail);
      return;
    }

    // The guard detail is dropped with the encoding.
    assert(exit.payload === undefined, "cannot reroute an exit carrying a payload");

    switch (reroute.kind) {
      case "fallthrough":
        // Past the remaining edge bodies to the wrapper's end; with none
        // left the fragment's code simply ends here.
        if (openEdgeBlocks > 0) {
          assert(wrapped, "a non-final fallthrough exit needs the wrapper block");
          body.br(openEdgeBlocks);
        }

        return;
      case "br":
        body.br(reroute.depth + openEdgeBlocks + (wrapped ? 1 : 0));
        return;
    }
  }

  function emitReturn(exit: ExitAction, detail: number): void {
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
    emitExit,
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

// A fallthrough-lowered exit emitted while later edge bodies remain must
// branch past them, so the fragment wraps itself in one block whose end is
// the fall-through target. The last edge body — and the terminator of an
// edge-less block — already falls out of the fragment directly.
function needsFallthroughWrapper(
  nested: readonly EdgeRegion[],
  terminator: Action,
  exitReroute: (reason: ActionExitReason) => ExitReroute | undefined
): boolean {
  if (terminator.kind === "exit" && nested.length > 0 && exitReroute(terminator.reason)?.kind === "fallthrough") {
    return true;
  }

  return nested.some(
    (edge, index) => index < nested.length - 1 && exitReroute(edge.exit.reason)?.kind === "fallthrough"
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
    case "next":
      return ExitReason.FALLTHROUGH;
    case "jump":
      return ExitReason.JUMP;
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
