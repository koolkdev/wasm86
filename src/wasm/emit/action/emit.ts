import { assert } from "#common/assert.js";
import type {
  Action,
  ActionBlock,
  EdgeRegion,
  GuardMemoryAction,
  RegionId
} from "#ir/action/types.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { emitExit, withEdgeBlocks } from "./control.js";
import { emitGuardChecks, emitGuestLoad, emitGuestStore } from "./memory.js";
import { emitChannelLoad, emitChannelStore } from "./state.js";
import { createValueStack } from "./value-stack.js";
import { analyzeBlockValues } from "./values.js";

// The emitter driver: walks an ActionBlock in action order and fills the
// given function body. Its product is a function body, never a module —
// module assembly (imports, exports, ABI) belongs to the backends; the only
// module wrapping under emit/action is the test harness.

export type ActionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
}>;

export function emitActionBlock(block: ActionBlock, context: ActionEmitContext): WasmFunctionBodyEncoder {
  const { body } = context;
  const entry = block.regions.find((region) => region.id === block.entry);

  assert(entry !== undefined && entry.kind === "entry", "action block entry region is missing");

  const edges = block.regions.filter((region): region is EdgeRegion => region.kind === "edge");

  assert(block.regions.length === edges.length + 1, "action block has more than one entry region");
  assert(
    entry.actions[entry.actions.length - 1]?.kind === "exit",
    "action region does not terminate with an exit"
  );

  const scratch = new WasmLocalScratchAllocator(body);
  const valueStack = createValueStack({
    body,
    scratch,
    values: block.values,
    analysis: analyzeBlockValues(block),
    // Nothing binds external values yet: blocks come from the builder, which
    // rejects external operand bindings.
    externalLocals: new Map(),
    loadSlot: (slot, signed) => emitChannelLoad(body, slot, signed),
    loadGuest: (width, signed) => emitGuestLoad(body, width, signed)
  });
  // Guards are 1:1 with their edges; the guard's byte length resurfaces at
  // the edge's exit as the fault size detail.
  const edgeFaultSizes = new Map<RegionId, number>();

  function emitEntryAction(action: Action, faultDepthOf: (edge: RegionId) => number): void {
    switch (action.kind) {
      case "readState":
        valueStack.readState(action);
        return;
      case "readMemory":
        valueStack.readMemory(action);
        return;
      case "writeState":
        emitChannelStore(body, action.slot, () => valueStack.emitUse(action.value));
        return;
      case "writeMemory":
        valueStack.emitUse(action.address);
        valueStack.emitUse(action.value);
        emitGuestStore(body, action.width);
        return;
      case "guardMemory":
        emitGuard(action, faultDepthOf);
        return;
      case "exit":
        emitExit(body, action, valueStack.emitUse);
        return;
      case "branch":
        throw new Error("branch not supported by action emitter yet");
    }
  }

  function emitGuard(action: GuardMemoryAction, faultDepthOf: (edge: RegionId) => number): void {
    const edge = edges.find((candidate) => candidate.id === action.faultEdge);

    assert(edge !== undefined, `guard targets unknown fault edge ${action.faultEdge}`);
    assert(!edgeFaultSizes.has(edge.id), `fault edge ${edge.id} is targeted by more than one guard`);
    edgeFaultSizes.set(edge.id, action.byteLength);

    valueStack.captureForEdge(edge);
    emitGuardChecks(
      body,
      action.byteLength,
      () => valueStack.emitUse(action.address),
      faultDepthOf(edge.id)
    );
  }

  function emitEdgeBody(edge: EdgeRegion): void {
    const faultSize = edgeFaultSizes.get(edge.id);

    assert(faultSize !== undefined, `edge region ${edge.id} is not targeted by a guard`);

    for (const flush of edge.flushes) {
      emitChannelStore(body, flush.slot, () => valueStack.emitUse(flush.value));
    }

    emitExit(body, edge.exit, valueStack.emitUse, faultSize);
  }

  withEdgeBlocks(
    body,
    edges,
    (faultDepthOf) => {
      for (const action of entry.actions) {
        emitEntryAction(action, faultDepthOf);
      }
    },
    emitEdgeBody
  );

  valueStack.assertClear();
  scratch.assertClear();
  return body.end();
}
