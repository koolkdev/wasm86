import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type {
  Action,
  BranchAction,
  GuardMemoryAction
} from "#ir/actions.js";
import type { EdgeRegion, IrBlock, RegionId } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import type { ValueId } from "#ir/values.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { createControlFrame } from "./control.js";
import type { FragmentEmbedding, FunctionEmbedding } from "./embed.js";
import { emitGuardChecks, emitGuestLoad, emitGuestStore } from "./memory.js";
import { emitSlotLoad, emitSlotStore } from "./state.js";
import { createValueStack } from "./value-stack.js";
import { analyzeBlockValues, type BlockValueAnalysis } from "./values.js";
import type { WasmHelperRegistry } from "#wasm/helpers/module.js";

// The emitter driver: walks an IrBlock in action order and fills the
// given function body. Its product is a function body, never a module —
// module assembly (imports, exports, ABI) belongs to the engines; the only
// module wrapping under emit is the test harness. A fragment leaves
// its body open for the embedder.

export type ActionFragmentContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  // The enclosing function's allocator; the fragment frees every local it
  // takes.
  scratch: WasmLocalScratchAllocator;
  externalLocals?: ReadonlyMap<ExternalValueId, number>;
  helpers?: WasmHelperRegistry | undefined;
  analysis?: BlockValueAnalysis | undefined;
  embedding: FragmentEmbedding;
}>;

export type ActionFunctionContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  helpers?: WasmHelperRegistry | undefined;
  analysis?: BlockValueAnalysis | undefined;
  embedding: FunctionEmbedding;
}>;

// The function-shaped entry point: the block is the whole function body.
export function emitActionFunction(block: IrBlock, context: ActionFunctionContext): WasmFunctionBodyEncoder {
  const scratch = new WasmLocalScratchAllocator(context.body);

  emitActionFragment(block, {
    body: context.body,
    scratch,
    helpers: context.helpers,
    analysis: context.analysis,
    embedding: context.embedding
  });
  scratch.assertClear();
  return context.body.end();
}

export function emitActionFragment(block: IrBlock, context: ActionFragmentContext): void {
  validateIrBlock(block);

  const { body, embedding } = context;
  const entry = block.regions.find((region) => region.id === block.entry);

  assert(entry !== undefined && entry.kind === "entry", "IR block entry region is missing");

  const edges = block.regions.filter((region): region is EdgeRegion => region.kind === "edge");
  const outputs = embedding.outputs ?? new Map<ValueId, number>();
  const analysis = context.analysis ?? analyzeBlockValues(block, outputs.keys());
  const valueStack = createValueStack({
    body,
    scratch: context.scratch,
    values: block.values,
    analysis,
    externalLocals: context.externalLocals ?? new Map(),
    helpers: context.helpers,
    loadSlot: (slot, signed, emitUse) => emitSlotLoad(body, slot, signed, emitUse),
    loadGuest: (width, signed) => emitGuestLoad(body, width, signed)
  });
  // Per-edge report detail (the guard's byte length); branch edges record
  // a zero that only marks them as targeted.
  const edgeExitDetails = new Map<RegionId, number>();
  const terminator = entry.actions[entry.actions.length - 1];
  const entryContinuation = entry.continuation;

  assert(terminator !== undefined, "entry region does not end with a terminator");

  const frame = createControlFrame({
    body,
    completion: embedding.completion,
    emitPayload: valueStack.emitUse,
    constValue: (id) => block.values.constValue(id)
  });

  function emitEntryAction(action: Action): void {
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
        emitGuard(action);
        return;
      case "exit":
        frame.emitReport(action);
        return;
      case "continue":
        frame.emitCompletion(entryContinuation);
        return;
      case "branch":
        emitBranch(action);
        return;
    }
  }

  function emitGuard(action: GuardMemoryAction): void {
    const edge = edgeById(action.faultEdge);

    edgeExitDetails.set(edge.id, action.byteLength);
    valueStack.captureForEdge(edge);
    frame.withNestedControl(() => {
      emitGuardChecks(
        body,
        action.byteLength,
        () => valueStack.emitUse(action.address),
        () => emitEdgeBody(edge)
      );
    });
  }

  // Both edges' values are captured before any path leaves the entry.
  function emitBranch(action: BranchAction): void {
    const taken = edgeById(action.taken);
    const notTaken = edgeById(action.notTaken);

    edgeExitDetails.set(taken.id, 0);
    edgeExitDetails.set(notTaken.id, 0);
    valueStack.captureForEdge(taken);
    valueStack.captureForEdge(notTaken);
    valueStack.emitUse(action.condition);
    body.ifBlock();
    frame.withNestedControl(() => {
      emitEdgeBody(taken);
      body.elseBlock();
      emitEdgeBody(notTaken);
    });
    body.endBlock();

    if (embedding.completion.kind === "link") {
      body.unreachable();
    }
  }

  // Every store ordered before the terminator has executed by now, and
  // both branch paths see the exports.
  function emitExportedOutputs(): void {
    for (const [id, local] of outputs) {
      valueStack.emitUse(id);
      body.localSet(local);
    }
  }

  function emitEdgeBody(edge: EdgeRegion): void {
    const detail = edgeExitDetails.get(edge.id);

    assert(detail !== undefined, `edge region ${edge.id} was never targeted by the entry`);

    for (const flush of edge.flushes) {
      emitSlotStore(body, flush.slot, flush.value, valueStack.emitUse);
    }

    switch (edge.terminator.kind) {
      case "exit":
        frame.emitReport(edge.terminator, detail);
        return;
      case "continue":
        frame.emitCompletion(edge.continuation);
        return;
    }
  }

  function edgeById(id: RegionId): EdgeRegion {
    const edge = edges.find((candidate) => candidate.id === id);

    assert(edge !== undefined, `no edge region ${id} in this block`);
    return edge;
  }

  for (const action of entry.actions.slice(0, -1)) {
    emitEntryAction(action);
  }

  emitExportedOutputs();
  emitEntryAction(terminator);

  valueStack.assertClear();
}
