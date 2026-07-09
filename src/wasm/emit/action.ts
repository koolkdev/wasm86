import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import {
  actionCompletes,
  bodyFinal,
  type Action,
  type BranchHint,
  type LoopContinueAction,
  type LoopAction,
  type SwitchCase
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import { loopInputsOf, nestedBodies } from "#ir/traverse.js";
import { validateIrBlock } from "#ir/validate.js";
import type { ValueId } from "#ir/values.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmBranchHint, type WasmBranchHint, type WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { createControlFrame } from "./control.js";
import type { FragmentEmbedding, FunctionEmbedding } from "./embed.js";
import { emitOp } from "./ops.js";
import { wasmTypeForValue } from "./operators.js";
import { analyzePlacement, type BlockPlacement } from "./placement.js";
import { ValueStack } from "./value-stack.js";
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
  placement?: BlockPlacement | undefined;
  embedding: FragmentEmbedding;
}>;

export type ActionFunctionContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  helpers?: WasmHelperRegistry | undefined;
  placement?: BlockPlacement | undefined;
  embedding: FunctionEmbedding;
}>;

// The function-shaped entry point: the block is the whole function body.
export function emitActionFunction(block: IrBlock, context: ActionFunctionContext): WasmFunctionBodyEncoder {
  const scratch = new WasmLocalScratchAllocator(context.body);

  emitActionFragment(block, {
    body: context.body,
    scratch,
    helpers: context.helpers,
    placement: context.placement,
    embedding: context.embedding
  });
  scratch.assertClear();
  return context.body.end();
}

export function emitActionFragment(block: IrBlock, context: ActionFragmentContext): void {
  validateIrBlock(block, { allowImplicitEntryFallthrough: context.embedding.fallthrough !== undefined });

  const { body, embedding } = context;
  const outputs = embedding.outputs ?? new Map<ValueId, number>();
  const placement = context.placement ?? analyzePlacement(block, outputs.keys());
  const valueStack = new ValueStack({
    body,
    scratch: context.scratch,
    values: block.values,
    placement,
    externalLocals: context.externalLocals ?? new Map(),
    emitOp: (op, operands) => emitOp(body, context.helpers, op, operands)
  });
  const terminator = bodyFinal(block.body);

  const frame = createControlFrame({
    body,
    dispatch: embedding.dispatch,
    fallthrough: embedding.fallthrough,
    emitPayload: (id) => valueStack.emitUse(id),
    constValue: (id) => block.values.constValue(id)
  });

  // The innermost open loop's carried locals, aligned with its carried list.
  const loopCellLocals: number[][] = [];

  function emitAction(action: Action): void {
    switch (action.kind) {
      case "op":
        // Output-producing ops route through placement; the rest execute
        // at their action point.
        if (opAccess(action.op).valueOutput === undefined) {
          emitOp(body, context.helpers, action.op, valueStack);
        } else {
          valueStack.scheduledProducer(action);
        }

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
        assert(false, "unknown finish kind");
        return;
      case "if":
        emitIf(action);
        return;
      case "switch":
        emitSwitch(action);
        return;
      case "loop":
        emitLoop(action);
        return;
      case "loopContinue":
        emitLoopContinue(action);
        return;
    }
  }

  // Captures first — loop-invariant values and entry-anchored producers
  // materialize on the enclosing flow — then one local per carried cell,
  // seeded before the loop opens and bound to the cell's loop input.
  function emitLoop(action: LoopAction): void {
    valueStack.captureForBody(action.body, loopInputsOf(action));

    const locals = action.carried.map((cell) => {
      valueStack.emitUse(cell.seed);

      const local = context.scratch.allocLocal(wasmTypeForValue(block.values.valueType(cell.loopInput)));

      body.localSet(local);
      valueStack.bindLoopInput(cell.loopInput, local);
      return local;
    });

    body.loop();
    loopCellLocals.push(locals);
    // The body re-executes per iteration: locals captured before the loop
    // must not recycle inside it.
    context.scratch.pushReuseBarrier();
    frame.withLoopBody(() => emitBody(action.body));
    context.scratch.popReuseBarrier();
    loopCellLocals.pop();
    body.endBlock();

    for (const [index, cell] of action.carried.entries()) {
      valueStack.unbindLoopInput(cell.loopInput);
      context.scratch.freeLocal(locals[index]!);
    }
  }

  // All updates compute before any local rewrites — an update may read
  // another cell's loop input — then the sets pop in reverse.
  function emitLoopContinue(action: LoopContinueAction): void {
    const locals = loopCellLocals[loopCellLocals.length - 1];

    assert(locals !== undefined, "loopContinue action outside any loop body");
    assert(action.updates.length === locals.length, "loopContinue updates do not align with the loop's cells");

    for (const update of action.updates) {
      valueStack.emitUse(update);
    }

    for (let index = locals.length - 1; index >= 0; index -= 1) {
      body.localSet(locals[index]!);
    }

    frame.emitLoopContinue();
  }

  // The condition emits first so values it shares with the bodies tee at
  // their first use; both bodies' values are then captured — stack-neutral
  // sets under the pushed condition — before any path leaves the parent.
  function emitIf(action: Extract<Action, { kind: "if" }>): void {
    valueStack.emitUse(action.condition);
    valueStack.captureForBody(action.thenBody);

    if (action.elseBody !== undefined) {
      valueStack.captureForBody(action.elseBody);
    }

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

  // Captures first, then br_table selects among one block per case plus
  // default plus join; each arm parks its result in the output's local.
  // Arms emit under the frame with the switch's open label count, so
  // completions inside them escape correctly.
  function emitSwitch(action: Extract<Action, { kind: "switch" }>): void {
    for (const nested of nestedBodies(action)) {
      valueStack.captureForBody(nested);
    }

    const outputLocal = valueStack.claimActionOutput(action.output);
    const caseCount = action.cases.length;

    // Open order join, default, case n-1 .. case 0: case i lands at depth
    // i in br_table's index space, the default at caseCount. The selector
    // pushes inside the innermost block, where br_table can see it.
    for (let index = 0; index <= caseCount + 1; index += 1) {
      body.block();
    }

    valueStack.emitUse(action.selector);
    body.brTable(switchLabelDepths(action.cases), caseCount);

    const emitArm = (armBody: Body): void => {
      emitBody(armBody);

      const result = armBody.result;

      assert(result !== undefined, "switch arms without results have no producer yet");

      if (outputLocal !== undefined) {
        valueStack.emitUse(result);
        body.localSet(outputLocal);
      } else if (block.values.node(result).kind === "unreachable") {
        // The path stays impossible even when nothing demands the output.
        body.unreachable();
      }
    };

    action.cases.forEach((switchCase, index) => {
      body.endBlock();
      frame.withNestedControl(() => emitArm(switchCase.body), caseCount - index + 1);
      body.br(caseCount - index);
    });

    body.endBlock();
    frame.withNestedControl(() => emitArm(action.defaultBody), 1);
    body.endBlock();
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

  valueStack.releaseVarLocals();
  valueStack.assertClear();
}

// The dense br_table label vector: entry m selects the case whose match is
// m — its body starts after closing the depth-m block — and every hole
// selects the default at depth cases.length.
function switchLabelDepths(cases: readonly SwitchCase[]): number[] {
  const size = cases.reduce((max, entry) => Math.max(max, entry.match + 1), 0);
  const table = new Array<number>(size).fill(cases.length);

  for (const [depth, entry] of cases.entries()) {
    table[entry.match] = depth;
  }

  return table;
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
