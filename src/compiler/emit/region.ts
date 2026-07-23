import { assert } from "#common/assert.js";
import type { ControlEmitTarget } from "#compiler/ir/controls/index.js";
import type { IrFunction } from "#compiler/ir/function.js";
import {
  regionCompletes,
  regionFinal,
  type Region,
  type RegionNode
} from "#compiler/ir/region.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";
import type { FunctionPlacement } from "#compiler/placement/place.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import {
  createFunctionFrame,
  emitCall,
  emitReturnCall
} from "./context.js";
import { ValueEmitter } from "./value.js";

export type RegionEmitContext = Readonly<{
  body: WasmInstructionWriter;
  bindings: ModuleBindings;
  placement: FunctionPlacement;
  locals: readonly number[];
}>;

export function emitFunctionRegions(
  fn: IrFunction,
  context: RegionEmitContext
): void {
  const { body, bindings, placement, locals } = context;
  const { analysis, plan, index } = placement;
  const valueEmitter = new ValueEmitter({
    body,
    values: fn.values,
    analysis,
    plan,
    index,
    locals,
    bindings
  });
  const frame = createFunctionFrame({ body });
  // The innermost open loop's actual Wasm locals, aligned with its cells.
  const loopLocals: (readonly number[])[] = [];
  const controlTarget: ControlEmitTarget = {
    body,
    regionCompletes,
    emitCall: (target) => emitCall(body, bindings, target),
    emitReturnCall: (target) => emitReturnCall(body, bindings, target),
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
    withLoopBody(loopBodyLocals, emit) {
      loopLocals.push(loopBodyLocals);
      try {
        frame.withLoopBody(emit);
      } finally {
        assert(loopLocals.pop() === loopBodyLocals, "loop local stack changed");
      }
    },
    currentLoopLocals() {
      const current = loopLocals[loopLocals.length - 1];

      assert(current !== undefined, "loopContinue control outside any loop body");
      return current;
    },
    emitLoopBranch: () => frame.emitLoopContinue(),
    sealCompletedStructuredControl() {
      // Wasm cannot infer that every lowered arm exits through its nested
      // control flow, so make the structured join explicitly unreachable.
      body.unreachable();
    }
  };

  function emitAtSite(
    region: Region,
    nodeIndex: number,
    emit: () => void
  ): void {
    const site = analysis.siteOf(region, nodeIndex);

    valueEmitter.withSite(site, emit);
  }

  function emitNode(node: RegionNode): void {
    if (node.category === "control") {
      node.emit(controlTarget, valueEmitter);
      return;
    }

    // Live producer outputs realize the operation through their value anchor.
    // Required operations with no live result execute at their structural site.
    if (
      !node.outputs.some((output) => analysis.isLive(output)) &&
      analysis.operationMustExecute(node)
    ) {
      valueEmitter.emitOperation(node);
      for (const _output of node.outputs) {
        body.drop();
      }
    }
  }

  function emitBody(region: Region, resultLocal?: number): void {
    for (const [nodeIndex, node] of region.nodes.entries()) {
      emitAtSite(region, nodeIndex, () => emitNode(node));
    }

    if (region.result !== undefined || regionFinal(region) === undefined) {
      emitAtSite(region, region.nodes.length, () => {
        const result = region.result;

        if (result === undefined) {
          return;
        }
        if (resultLocal !== undefined) {
          valueEmitter.emitUse(result);
          body.localSet(resultLocal);
        } else if (fn.values.isUnreachable(result)) {
          valueEmitter.emitUse(result);
        }
      });
    }
  }

  emitBody(fn.body);
  valueEmitter.assertComplete();
}
