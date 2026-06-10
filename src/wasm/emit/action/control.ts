import { assert } from "#common/assert.js";
import type { ActionExitReason, EdgeRegion, ExitAction, RegionId } from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";

// Edge-region encoding and exit lowering.

// Edge regions encode as wasm blocks: a guard br_ifs to its edge's label,
// and the edge body sits right after that block's end — the first edge is
// innermost, so an edge's label depth from the entry code is its position
// in region order. Regions end with an exit, so nothing falls through
// between them.
export function withEdgeBlocks(
  body: WasmFunctionBodyEncoder,
  edges: readonly EdgeRegion[],
  emitEntry: (faultDepthOf: (edge: RegionId) => number) => void,
  emitEdgeBody: (edge: EdgeRegion) => void
): void {
  const depths = new Map<RegionId, number>(edges.map((edge, index) => [edge.id, index]));

  for (let index = 0; index < edges.length; index += 1) {
    body.block();
  }

  emitEntry((edge) => {
    const depth = depths.get(edge);

    assert(depth !== undefined, `no edge region ${edge} in this block`);
    return depth;
  });

  for (const edge of edges) {
    body.endBlock();
    emitEdgeBody(edge);
  }
}

// The default exit lowering: return the encoded i64 exit. Embeddings with
// other strategies (fall through, br to a loop head) configure it later.
export function emitExit(
  body: WasmFunctionBodyEncoder,
  action: ExitAction,
  emitPayload: (id: ValueId) => void,
  detail = 0
): void {
  const reason = exitReasonCode(action.reason);

  if (action.payload === undefined) {
    body.i64Const(encodeExit(reason, 0, detail)).returnFromFunction();
    return;
  }

  emitPayload(action.payload);
  body.i64ExtendI32U().i64Const(encodeExit(reason, 0, detail)).i64Or().returnFromFunction();
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
