import { assert } from "#common/assert.js";
import type { IrFunction } from "#compiler/ir/function.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";
import type { FunctionPlacement } from "#compiler/placement/place.js";
import {
  encodeWasmFunctionBody,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { emitFunctionRegions } from "./region.js";
import { wasmTypeForValue } from "./values.js";

export type FunctionEmitContext = Readonly<{
  bindings: ModuleBindings;
  placement: FunctionPlacement;
}>;

export function emitFunction(
  fn: IrFunction,
  context: FunctionEmitContext
): EncodedWasmFunctionBody {
  assert(context.placement.function === fn, "placement belongs to another IR function");

  const localTypes = context.placement.plan.localTypes.map((type) =>
    wasmTypeForValue(type)
  );

  return encodeWasmFunctionBody({
    parameterCount: fn.parameters.length,
    localTypes
  }, (body, resolveLocal) => {
    emitFunctionRegions(fn, {
      body,
      bindings: context.bindings,
      placement: context.placement,
      resolveLocal
    });
  });
}
