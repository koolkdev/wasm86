import type { Function as IrFunction } from "#compiler/wasm/legacy/function.js";
import { describeNode } from "#compiler/ir/node.js";
import { regionCompletes, type Region, type RegionNode } from "#compiler/ir/region.js";
import type { ModuleBindings } from "#compiler/wasm/module/bindings.js";
import type { FunctionPlacement } from "#compiler/wasm/legacy/placement/place.js";
import type { WasmLocalResolver } from "#compiler/wasm/encoder/function-body.js";
import { wasmInstruction } from "#compiler/wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#compiler/wasm/encoder/instruction-writer.js";
import { createControlEmitter } from "./controls.js";
import { emitOperation } from "./operations.js";
import { ValueEmitter } from "./values.js";

export type RegionEmitContext = Readonly<{
  body: WasmInstructionWriter;
  bindings: ModuleBindings;
  placement: FunctionPlacement;
  resolveLocal: WasmLocalResolver;
}>;

export function emitFunctionRegions(fn: IrFunction, context: RegionEmitContext): void {
  const { body, bindings, placement, resolveLocal } = context;
  const { analysis, plan, index } = placement;
  const valueEmitter = new ValueEmitter({
    body,
    values: fn.values,
    analysis,
    plan,
    index,
    resolveLocal,
    bindings
  });
  const emitControl = createControlEmitter({
    body,
    bindings,
    plan,
    valueEmitter,
    emitBody
  });

  function emitAtSite(region: Region, nodeIndex: number, emit: () => void): void {
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
    const { outputs } = describeNode(node);

    if (!outputs.some((output) => analysis.isLive(output)) && analysis.operationMustExecute(node)) {
      emitOperation(body, bindings, valueEmitter, node);
      for (const _output of outputs) {
        body.write(wasmInstruction.parametric.drop);
      }
    }
  }

  function emitBody(region: Region, resultLocal?: number): void {
    for (const [nodeIndex, node] of region.nodes.entries()) {
      emitAtSite(region, nodeIndex, () => emitNode(node));
    }

    if (region.result !== undefined || !regionCompletes(region)) {
      emitAtSite(region, region.nodes.length, () => {
        const result = region.result;

        if (result === undefined) {
          return;
        }
        if (resultLocal !== undefined) {
          valueEmitter.emitUse(result);
          body.write(wasmInstruction.local.set, resultLocal);
        } else if (fn.values.isUnreachable(result)) {
          valueEmitter.emitUse(result);
        }
      });
    }
  }

  emitBody(fn.body);
  valueEmitter.assertComplete();
}
