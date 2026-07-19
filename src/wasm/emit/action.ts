import { assert } from "#common/assert.js";
import {
  bodyCompletes,
  bodyFinal,
  type Body,
  type BodyNode,
  type IrBlock
} from "#ir/block.js";
import type { ControlEmitTarget } from "#compiler/ir/controls/index.js";
import type { ExternalValueId, ValueId } from "#compiler/ir/values/types.js";
import {
  placeBody,
  type BodyPlacement
} from "#compiler/placement/place.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { createCompletionFrame } from "./completion-frame.js";
import type { FragmentEmbedding, FunctionEmbedding } from "./embed.js";
import { ValueEmitter, wasmTypeForValue } from "./value-emitter.js";
import type { ModuleBindings } from "#compiler/program/bindings.js";
import type { IrFunction } from "#ir/function.js";

export type ActionFragmentContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  externalLocals?: ReadonlyMap<ExternalValueId, number>;
  bindings: ModuleBindings;
  placement?: BodyPlacement | undefined;
  embedding: FragmentEmbedding;
}>;

export type ActionFunctionContext = Readonly<{
  bindings: ModuleBindings;
  placement?: BodyPlacement | undefined;
  embedding: FunctionEmbedding;
}>;

export type FunctionEmitContext = Readonly<{
  bindings: ModuleBindings;
  placement: BodyPlacement;
}>;

export function emitFunction(
  fn: IrFunction,
  context: FunctionEmitContext
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder(fn.parameters.length);
  const scratch = new WasmLocalScratchAllocator(body);

  emitActionFragment(fn, {
    body,
    scratch,
    bindings: context.bindings,
    placement: context.placement,
    embedding: {}
  });
  scratch.assertClear();
  return body.finish();
}

export function emitActionFunction(
  block: IrBlock,
  context: ActionFunctionContext
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);

  emitActionFragment(block, {
    body,
    scratch,
    bindings: context.bindings,
    placement: context.placement,
    embedding: context.embedding
  });
  scratch.assertClear();
  return body.finish();
}

export function emitActionFragment(block: IrBlock, context: ActionFragmentContext): void {
  const { body, embedding } = context;
  const exportLocals = embedding.outputs ?? new Map<ValueId, number>();
  const placement = resolvePlacement(block, context, exportLocals.keys());
  const { analysis, plan, index } = placement;
  const locals = plan.localTypes.map((type) =>
    context.scratch.allocLocal(wasmTypeForValue(type))
  );

  try {
    const valueEmitter = new ValueEmitter({
      body,
      values: block.values,
      analysis,
      plan,
      index,
      locals,
      externalLocals: context.externalLocals ?? new Map(),
      bindings: context.bindings
    });
    const frame = createCompletionFrame({
      body,
      dispatch: embedding.dispatch,
      fallthrough: embedding.fallthrough,
      emitValue: (id) => valueEmitter.emitUse(id),
      constValue: (id) => block.values.constValue(id)
    });
    const rootFinal = bodyFinal(block.body);
    const exportSite = analysis.siteOf(
      block.body,
      rootFinal === undefined ? block.body.nodes.length : block.body.nodes.length - 1
    );
    // The innermost open loop's actual Wasm locals, aligned with its cells.
    const loopLocals: (readonly number[])[] = [];
    const controlTarget: ControlEmitTarget = {
      body,
      bodyCompletes,
      bindings: context.bindings,
      emitCaptures: () => valueEmitter.emitCaptures(),
      emitBody,
      controlOutputLocal(output) {
        const outputPlacement = plan.values[output];

        assert(
          outputPlacement === undefined || outputPlacement.kind === "control",
          `control output ${output} has the wrong placement`
        );
        return outputPlacement === undefined
          ? undefined
          : valueEmitter.valueLocal(output);
      },
      markControlOutput: (output) => valueEmitter.markControlOutput(output),
      valueLocal: (value) => valueEmitter.valueLocal(value),
      withNestedControl: (emit, labels = 1) => frame.withNestedControl(emit, labels),
      withLoopBody(locals, emit) {
        loopLocals.push(locals);
        try {
          frame.withLoopBody(emit);
        } finally {
          assert(loopLocals.pop() === locals, "loop local stack changed");
        }
      },
      currentLoopLocals() {
        const locals = loopLocals[loopLocals.length - 1];

        assert(locals !== undefined, "loopContinue control outside any loop body");
        return locals;
      },
      emitLoopBranch: () => frame.emitLoopContinue(),
      emitExit: (result) => frame.emitExit(result),
      emitDispatch: (targetEip) => frame.emitDispatch(targetEip),
      sealCompletedStructuredControl() {
        if (embedding.dispatch?.kind === "link") {
          body.unreachable();
        }
      }
    };

    function emitAtSite(
      nodeBody: Body,
      nodeIndex: number,
      emit: () => void
    ): void {
      const site = analysis.siteOf(nodeBody, nodeIndex);

      valueEmitter.withSite(site, () => {
        if (site === exportSite) {
          for (const value of analysis.exportedOutputs()) {
            const local = exportLocals.get(value);

            assert(local !== undefined, `exported value ${value} has no embedding local`);
            valueEmitter.emitUse(value);
            body.localSet(local);
          }
        }
        emit();
      });
    }

    function emitNode(node: BodyNode): void {
      if (node.category === "control") {
        node.emit(controlTarget, valueEmitter);
        return;
      }

      const operationOutputs = node.outputs;

      // Live producer outputs realize the operation through their value
      // anchor. Required operations with no live result execute here.
      if (
        !operationOutputs.some((output) => analysis.isLive(output)) &&
        analysis.operationMustExecute(node)
      ) {
        valueEmitter.emitOperation(node);
        for (const _output of operationOutputs) {
          body.drop();
        }
      }
    }

    function emitBody(nodeBody: Body, resultLocal?: number): void {
      for (const [nodeIndex, node] of nodeBody.nodes.entries()) {
        emitAtSite(nodeBody, nodeIndex, () => emitNode(node));
      }

      if (nodeBody.result !== undefined || bodyFinal(nodeBody) === undefined) {
        emitAtSite(nodeBody, nodeBody.nodes.length, () => {
          const result = nodeBody.result;

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
