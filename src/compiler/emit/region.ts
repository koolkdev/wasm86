import type { IrFunction } from "#compiler/ir/function.js";
import {
  regionFinal,
  type Region,
  type RegionNode
} from "#compiler/ir/region.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";
import type { FunctionPlacement } from "#compiler/placement/place.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import { createControlEmitter } from "./controls.js";
import { emitOperation } from "./operations.js";
import { ValueEmitter } from "./values.js";

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
  const emitControl = createControlEmitter({
    body,
    bindings,
    plan,
    valueEmitter,
    emitBody
  });

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
      emitControl(node);
      return;
    }

    // Live producer outputs realize the operation through their value anchor.
    // Required operations with no live result execute at their structural site.
    if (
      !node.outputs.some((output) => analysis.isLive(output)) &&
      analysis.operationMustExecute(node)
    ) {
      emitOperation(body, bindings, valueEmitter, node);
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
