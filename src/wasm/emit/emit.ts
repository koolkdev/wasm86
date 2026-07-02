import type { ExternalValueId } from "#ir/operands.js";
import {
  actionCompletes,
  bodyFinal,
  type Action,
  type BranchHint,
  type GuardMemoryAction
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import type { ValueId } from "#ir/values.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmBranchHint, type WasmBranchHint, type WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { createControlFrame } from "./control.js";
import type { FragmentEmbedding, FunctionEmbedding } from "./embed.js";
import { emitGuardChecks, emitGuestLoad, emitGuestStore, emitMemoryCheckFromStack } from "./memory.js";
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
  validateIrBlock(block, { allowImplicitEntryFallthrough: context.embedding.fallthrough !== undefined });

  const { body, embedding } = context;
  const outputs = embedding.outputs ?? new Map<ValueId, number>();
  const analysis = context.analysis ?? analyzeBlockValues(block, outputs.keys());
  const valueStack = createValueStack({
    body,
    scratch: context.scratch,
    values: block.values,
    analysis,
    externalLocals: context.externalLocals ?? new Map(),
    helpers: context.helpers,
    loadSlot: (slot, signed, operands) => emitSlotLoad(body, slot, signed, operands),
    loadGuest: (width, signed) => emitGuestLoad(body, width, signed),
    checkGuest: (byteLength) => emitMemoryCheckFromStack(body, byteLength)
  });
  const terminator = bodyFinal(block.body);

  const frame = createControlFrame({
    body,
    dispatch: embedding.dispatch,
    fallthrough: embedding.fallthrough,
    emitPayload: valueStack.emitUse,
    constValue: (id) => block.values.constValue(id)
  });

  function emitAction(action: Action): void {
    switch (action.kind) {
      case "op":
        emitOp(action);
        return;
      case "guardMemory":
        emitGuard(action);
        return;
      case "finish":
        switch (action.finish.kind) {
          case "exit":
            frame.emitReport(action.finish);
            return;
          case "dispatch":
            frame.emitDispatch(action.finish);
            return;
        }
      case "if":
        emitIf(action);
        return;
    }
  }

  function emitOp(action: Extract<Action, { kind: "op" }>): void {
    switch (action.op.kind) {
      case "state.read":
      case "memory.read":
      case "memory.check":
      case "cpu.resolveFlag":
        valueStack.scheduledProducer(action);
        return;
      case "state.write":
        emitSlotStore(body, action.op.slot, action.op.value, valueStack);
        return;
      case "memory.write":
        valueStack.emitUse(action.op.address);
        valueStack.emitUse(action.op.value);
        emitGuestStore(body, action.op.width);
        return;
    }
  }

  function emitGuard(action: GuardMemoryAction): void {
    valueStack.captureForBody(action.faultBody);
    frame.withNestedControl(() => {
      emitGuardChecks(
        body,
        action.byteLength,
        () => valueStack.emitUse(action.address),
        () => emitBody(action.faultBody)
      );
    });
  }

  // Both nested bodies' values are captured before any path leaves the parent.
  function emitIf(action: Extract<Action, { kind: "if" }>): void {
    valueStack.captureForBody(action.thenBody);

    if (action.elseBody !== undefined) {
      valueStack.captureForBody(action.elseBody);
    }

    valueStack.emitUse(action.condition);
    body.ifBlock(wasmHint(action.hint));
    frame.withNestedControl(() => {
      emitBody(action.thenBody);

      if (action.elseBody !== undefined) {
        body.elseBlock();
        emitBody(action.elseBody);
      }
    });
    body.endBlock();

    if (actionCompletes(action) && embedding.dispatch?.kind === "link") {
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

  function emitBody(actionBody: Body): void {
    for (const action of actionBody.actions) {
      emitAction(action);
    }
  }

  for (const action of terminator === undefined ? block.body.actions : block.body.actions.slice(0, -1)) {
    emitAction(action);
  }

  emitExportedOutputs();

  if (terminator !== undefined) {
    emitAction(terminator);
  } else {
    frame.emitFallthrough();
  }

  valueStack.assertClear();
}

function wasmHint(hint: BranchHint | undefined): WasmBranchHint | undefined {
  switch (hint) {
    case undefined:
      return undefined;
    case "unlikely":
      return wasmBranchHint.unlikely;
    case "likely":
      return wasmBranchHint.likely;
  }
}
