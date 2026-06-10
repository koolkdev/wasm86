import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/action/operands.js";
import type {
  Action,
  ActionBlock,
  BranchAction,
  EdgeRegion,
  GuardMemoryAction,
  RegionId
} from "#ir/action/types.js";
import { validateActionBlock } from "#ir/action/validate.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { emitExit, withEdgeBlocks } from "./control.js";
import { emitGuardChecks, emitGuestLoad, emitGuestStore } from "./memory.js";
import { emitSlotLoad, emitSlotStore } from "./state.js";
import { createValueStack } from "./value-stack.js";
import { analyzeBlockValues } from "./values.js";

// The emitter driver: walks an ActionBlock in action order and fills the
// given function body. Its product is a function body, never a module —
// module assembly (imports, exports, ABI) belongs to the backends; the only
// module wrapping under emit/action is the test harness.

export type ActionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  // External id -> the wasm local the embedding bound it to.
  externalLocals?: ReadonlyMap<ExternalValueId, number>;
}>;

export function emitActionBlock(block: ActionBlock, context: ActionEmitContext): WasmFunctionBodyEncoder {
  validateActionBlock(block);

  const { body } = context;
  const entry = block.regions.find((region) => region.id === block.entry);

  assert(entry !== undefined && entry.kind === "entry", "action block entry region is missing");

  const edges = block.regions.filter((region): region is EdgeRegion => region.kind === "edge");
  const scratch = new WasmLocalScratchAllocator(body);
  const valueStack = createValueStack({
    body,
    scratch,
    values: block.values,
    analysis: analyzeBlockValues(block),
    externalLocals: context.externalLocals ?? new Map(),
    loadSlot: (slot, signed, emitUse) => emitSlotLoad(body, slot, signed, emitUse),
    loadGuest: (width, signed) => emitGuestLoad(body, width, signed)
  });
  // Exit detail per edge: the guard's byte length, zero for branch edges.
  const edgeExitDetails = new Map<RegionId, number>();

  function emitEntryAction(action: Action, edgeDepthOf: (edge: RegionId) => number): void {
    switch (action.kind) {
      case "readState":
        valueStack.readState(action);
        return;
      case "readMemory":
        valueStack.readMemory(action);
        return;
      case "writeState":
        emitSlotStore(body, action.slot, action.value, valueStack.emitUse);
        return;
      case "writeMemory":
        valueStack.emitUse(action.address);
        valueStack.emitUse(action.value);
        emitGuestStore(body, action.width);
        return;
      case "guardMemory":
        emitGuard(action, edgeDepthOf);
        return;
      case "exit":
        emitExit(body, action, valueStack.emitUse);
        return;
      case "branch":
        emitBranch(action, edgeDepthOf);
        return;
    }
  }

  function emitGuard(action: GuardMemoryAction, edgeDepthOf: (edge: RegionId) => number): void {
    const edge = edgeById(action.faultEdge);

    edgeExitDetails.set(edge.id, action.byteLength);
    valueStack.captureForEdge(edge);
    emitGuardChecks(
      body,
      action.byteLength,
      () => valueStack.emitUse(action.address),
      edgeDepthOf(edge.id)
    );
  }

  // Both edges' values are captured before any path leaves the entry.
  function emitBranch(action: BranchAction, edgeDepthOf: (edge: RegionId) => number): void {
    const taken = edgeById(action.taken);
    const notTaken = edgeById(action.notTaken);

    edgeExitDetails.set(taken.id, 0);
    edgeExitDetails.set(notTaken.id, 0);
    valueStack.captureForEdge(taken);
    valueStack.captureForEdge(notTaken);
    valueStack.emitUse(action.condition);
    body.brIf(edgeDepthOf(taken.id));
  }

  function emitEdgeBody(edge: EdgeRegion): void {
    const detail = edgeExitDetails.get(edge.id);

    assert(detail !== undefined, `edge region ${edge.id} was never targeted by the entry`);

    for (const flush of edge.flushes) {
      emitSlotStore(body, flush.slot, flush.value, valueStack.emitUse);
    }

    emitExit(body, edge.exit, valueStack.emitUse, detail);
  }

  function edgeById(id: RegionId): EdgeRegion {
    const edge = edges.find((candidate) => candidate.id === id);

    assert(edge !== undefined, `no edge region ${id} in this block`);
    return edge;
  }

  const terminator = entry.actions[entry.actions.length - 1];

  withEdgeBlocks(
    body,
    edges,
    terminator !== undefined && terminator.kind === "branch" ? terminator.notTaken : undefined,
    (edgeDepthOf) => {
      for (const action of entry.actions) {
        emitEntryAction(action, edgeDepthOf);
      }
    },
    emitEdgeBody
  );

  valueStack.assertClear();
  scratch.assertClear();
  return body.end();
}
