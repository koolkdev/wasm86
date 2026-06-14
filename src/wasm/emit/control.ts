import { assert } from "#common/assert.js";
import type { Action, ActionExitReason, ExitAction } from "#ir/actions.js";
import type { EdgeRegion, RegionId } from "#ir/block.js";
import type { ValueId } from "#ir/values.js";
import { u32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import type { CompletionPolicy, LinkCompletion } from "./embed.js";

// Edge-region encoding and terminator emission.

export type ControlFrameContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  edges: readonly EdgeRegion[];
  // The entry region's terminator.
  terminator: Action;
  // Where a completed block lands.
  completion: CompletionPolicy;
  // Pushes an exit payload value.
  emitPayload(id: ValueId): void;
  constValue(id: ValueId): number | undefined;
}>;

export type ControlFrame = Readonly<{
  // Label depth of the edge's block as seen from entry code.
  depthOf(edge: RegionId): number;
  // Detail is the guard's byte length on fault edges.
  emitReport(exit: ExitAction, detail?: number): void;
  // Continuation is the region's flushed eip.
  emitCompletion(continuation: ValueId | undefined): void;
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

  function emitCompletion(continuation: ValueId | undefined): void {
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
      case "link":
        emitLinkedCompletion(completion, continuation);
        return;
    }
  }

  // State is already flushed, so a constant target is a bare tail call. A
  // constant with neither a function nor a table slot is a bug: module
  // assembly walks the same continuations to build the table.
  function emitLinkedCompletion(link: LinkCompletion, continuation: ValueId | undefined): void {
    assert(continuation !== undefined, "a linked completion needs the region's eip flush");

    const target = context.constValue(continuation);

    if (target === undefined) {
      body.i64Const(encodeExit(ExitReason.DYNAMIC_JUMP, 0)).returnFromFunction();
      return;
    }

    const functionIndex = link.functionFor(target);

    if (functionIndex !== undefined) {
      body.returnCallFunction(functionIndex);
      return;
    }

    const slot = link.table?.slotFor(target);

    assert(
      link.table !== undefined && slot !== undefined,
      `constant link target 0x${u32(target).toString(16)} has no function or table slot`
    );
    body.i32Const(slot).returnCallIndirect(link.table.typeIndex, link.table.tableIndex);
  }

  function emitReport(exit: ExitAction, detail = 0): void {
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
    emitReport,
    emitCompletion,
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
