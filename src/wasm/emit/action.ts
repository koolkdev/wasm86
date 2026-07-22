import { assert } from "#common/assert.js";
import {
  bodyCompletes,
  bodyFinal,
  type Body,
  type BodyNode
} from "#ir/block.js";
import type { ControlEmitTarget } from "#compiler/ir/controls/index.js";
import type { BodyPlacement } from "#compiler/placement/place.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { createFunctionFrame } from "./completion-frame.js";
import { ValueEmitter, wasmTypeForValue } from "./value-emitter.js";
import type { ModuleBindings } from "#compiler/program/bindings.js";
import type { IrFunction } from "#ir/function.js";

type FunctionBodyEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  bindings: ModuleBindings;
  placement: BodyPlacement;
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

  emitFunctionBody(fn, {
    body,
    scratch,
    bindings: context.bindings,
    placement: context.placement
  });
  scratch.assertClear();
  return body.finish();
}

function emitFunctionBody(block: IrFunction, context: FunctionBodyEmitContext): void {
  const { body } = context;
  const placement = context.placement;
  assert(placement.block === block, "placement belongs to another IR function");
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
      bindings: context.bindings
    });
    const frame = createFunctionFrame({ body });
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
      sealCompletedStructuredControl() {
        // Wasm cannot infer that every lowered arm exits through its nested
        // control flow, so make the structured join explicitly unreachable.
        body.unreachable();
      }
    };

    function emitAtSite(
      nodeBody: Body,
      nodeIndex: number,
      emit: () => void
    ): void {
      const site = analysis.siteOf(nodeBody, nodeIndex);

      valueEmitter.withSite(site, () => {
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
    valueEmitter.assertComplete();
  } finally {
    for (const local of [...locals].reverse()) {
      context.scratch.freeLocal(local);
    }
  }
}
