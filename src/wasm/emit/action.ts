import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import {
  actionCompletes,
  bodyFinal,
  type Action,
  type BranchHint,
  type LoopAction,
  type LoopContinueAction,
  type SwitchCase
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  placeBody,
  type BodyPlacement
} from "#compiler/placement/place.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import {
  wasmBranchHint,
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody,
  type WasmBranchHint
} from "#compiler/encoder/function-body.js";
import { createControlFrame } from "./control.js";
import type { FragmentEmbedding, FunctionEmbedding } from "./embed.js";
import { ValueEmitter, wasmTypeForValue } from "./value-emitter.js";
import {
  resolveHelperFunctionIndex,
  type LegacyHelperIndexRegistryAdapter
} from "#wasm/helpers/registry.js";

export type ActionFragmentContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  externalLocals?: ReadonlyMap<ExternalValueId, number>;
  helpers?: LegacyHelperIndexRegistryAdapter | undefined;
  placement?: BodyPlacement | undefined;
  embedding: FragmentEmbedding;
}>;

export type ActionFunctionContext = Readonly<{
  helpers?: LegacyHelperIndexRegistryAdapter | undefined;
  placement?: BodyPlacement | undefined;
  embedding: FunctionEmbedding;
}>;

export function emitActionFunction(
  block: IrBlock,
  context: ActionFunctionContext
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);

  emitActionFragment(block, {
    body,
    scratch,
    helpers: context.helpers,
    placement: context.placement,
    embedding: context.embedding
  });
  scratch.assertClear();
  return body.finish();
}

export function emitActionFragment(block: IrBlock, context: ActionFragmentContext): void {
  const { body, embedding } = context;
  const outputs = embedding.outputs ?? new Map<ValueId, number>();
  const placement = resolvePlacement(block, context, outputs.keys());
  const { analysis, plan, index } = placement;
  const locals = plan.localTypes.map((type) =>
    context.scratch.allocLocal(wasmTypeForValue(type))
  );

  try {
    const valueEmitter = new ValueEmitter({
      body,
      scratch: context.scratch,
      values: block.values,
      analysis,
      plan,
      index,
      locals,
      externalLocals: context.externalLocals ?? new Map(),
      helperFunctionIndex: (helper) =>
        resolveHelperFunctionIndex(context.helpers, helper)
    });
    const frame = createControlFrame({
      body,
      dispatch: embedding.dispatch,
      fallthrough: embedding.fallthrough,
      emitPayload: (id) => valueEmitter.emitUse(id),
      constValue: (id) => block.values.constValue(id)
    });
    const rootFinal = bodyFinal(block.body);
    const exportSite = analysis.siteOf(
      block.body,
      rootFinal === undefined ? block.body.actions.length : block.body.actions.length - 1
    );
    // The innermost open loop's actual Wasm locals, aligned with its cells.
    const loopLocals: (readonly number[])[] = [];

    function emitAtSite(
      actionBody: Body,
      actionIndex: number,
      emit: () => void
    ): void {
      const site = analysis.siteOf(actionBody, actionIndex);

      valueEmitter.withSite(site, () => {
        if (site === exportSite) {
          for (const value of analysis.exportedOutputs()) {
            const local = outputs.get(value);

            assert(local !== undefined, `exported value ${value} has no embedding local`);
            valueEmitter.emitUse(value);
            body.localSet(local);
          }
        }
        emit();
      });
    }

    function emitAction(action: Action): void {
      switch (action.kind) {
        case "op":
          // Result-bearing operations execute through their value anchor.
          if (action.op.result === undefined) {
            valueEmitter.emitOperation(action.op);
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

    function emitLoop(action: LoopAction): void {
      const carriedLocals = action.carried.map((cell) => {
        const local = valueEmitter.valueLocal(cell.loopInput);

        valueEmitter.emitUse(cell.seed);
        body.localSet(local);
        return local;
      });

      valueEmitter.emitCaptures();
      body.loop();
      loopLocals.push(carriedLocals);
      frame.withLoopBody(() => emitBody(action.body));
      assert(loopLocals.pop() === carriedLocals, "loop local stack changed");
      body.endBlock();
    }

    // Compute all updates before overwriting any carried cell.
    function emitLoopContinue(action: LoopContinueAction): void {
      const carriedLocals = loopLocals[loopLocals.length - 1];

      assert(carriedLocals !== undefined, "loopContinue action outside any loop body");
      assert(
        action.updates.length === carriedLocals.length,
        "loopContinue updates do not align with the loop's cells"
      );
      for (const update of action.updates) {
        valueEmitter.emitUse(update);
      }
      for (let index = carriedLocals.length - 1; index >= 0; index -= 1) {
        body.localSet(carriedLocals[index]!);
      }
      frame.emitLoopContinue();
    }

    function emitIf(action: Extract<Action, { kind: "if" }>): void {
      const outputPlacement = action.output === undefined
        ? undefined
        : plan.values[action.output];

      assert(
        outputPlacement === undefined || outputPlacement.kind === "control",
        `if output ${action.output} has the wrong placement`
      );
      let outputLocal: number | undefined;

      if (outputPlacement !== undefined) {
        assert(action.output !== undefined, "placed if output is missing");
        outputLocal = valueEmitter.valueLocal(action.output);
      }

      valueEmitter.emitUse(action.condition);
      valueEmitter.emitCaptures();
      body.ifBlock({ hint: wasmHint(action.hint) });
      frame.withNestedControl(() => {
        emitBody(action.thenBody, outputLocal);

        if (action.elseBody !== undefined) {
          body.elseBlock();
          emitBody(action.elseBody, outputLocal);
        } else {
          assert(action.output === undefined, "value-producing if has no else body");
        }
      });
      body.endBlock();

      if (action.output !== undefined && outputPlacement !== undefined) {
        valueEmitter.markControlOutput(action.output);
      }
      if (actionCompletes(action) && embedding.dispatch?.kind === "link") {
        body.unreachable();
      }
    }

    function emitSwitch(action: Extract<Action, { kind: "switch" }>): void {
      const outputPlacement = plan.values[action.output];

      assert(
        outputPlacement === undefined || outputPlacement.kind === "control",
        `switch output ${action.output} has the wrong placement`
      );
      const outputLocal = outputPlacement === undefined
        ? undefined
        : valueEmitter.valueLocal(action.output);
      const caseCount = action.cases.length;

      // Open order: join, default, case n-1 .. case 0.
      for (let index = 0; index <= caseCount + 1; index += 1) {
        body.block();
      }

      valueEmitter.emitUse(action.selector);
      valueEmitter.emitCaptures();
      body.brTable(switchLabelDepths(action.cases), caseCount);

      action.cases.forEach((switchCase, index) => {
        body.endBlock();
        frame.withNestedControl(
          () => emitBody(switchCase.body, outputLocal),
          caseCount - index + 1
        );
        body.br(caseCount - index);
      });

      body.endBlock();
      frame.withNestedControl(() => emitBody(action.defaultBody, outputLocal), 1);
      body.endBlock();

      if (outputPlacement !== undefined) {
        valueEmitter.markControlOutput(action.output);
      }
    }

    function emitBody(actionBody: Body, resultLocal?: number): void {
      for (const [actionIndex, action] of actionBody.actions.entries()) {
        emitAtSite(actionBody, actionIndex, () => emitAction(action));
      }

      if (actionBody.result !== undefined || bodyFinal(actionBody) === undefined) {
        emitAtSite(actionBody, actionBody.actions.length, () => {
          const result = actionBody.result;

          if (result === undefined) {
            return;
          }
          if (resultLocal !== undefined) {
            valueEmitter.emitUse(result);
            body.localSet(resultLocal);
          } else if (block.values.isUnreachable(result)) {
            valueEmitter.emitUse(result);
          }
        });
      }
    }

    emitBody(block.body);
    if (rootFinal === undefined) {
      frame.emitFallthrough();
    }
    valueEmitter.assertComplete();
  } finally {
    for (const local of [...locals].reverse()) {
      context.scratch.freeLocal(local);
    }
  }
}

function resolvePlacement(
  block: IrBlock,
  context: ActionFragmentContext,
  outputs: Iterable<ValueId>
): BodyPlacement {
  const exportedOutputs = [...outputs];
  const placement = context.placement;

  if (placement === undefined) {
    return placeBody(block, {
      exportedOutputs,
      allowImplicitEntryFallthrough: context.embedding.fallthrough !== undefined
    });
  }

  assert(placement.block === block, "placement belongs to another IR block");
  assert(
    sameValues(placement.analysis.exportedOutputs(), exportedOutputs),
    "placement has different exported outputs"
  );
  return placement;
}

function sameValues(a: readonly ValueId[], b: readonly ValueId[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

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
