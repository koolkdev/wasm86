import { assert } from "#common/assert.js";
import type { Function as IrFunction } from "#compiler/wasm/legacy/function.js";
import type { ModuleBindings } from "#compiler/wasm/module/bindings.js";
import type { FunctionPlacement } from "#compiler/wasm/legacy/placement/place.js";
import {
  encodeWasmFunctionBody,
  type EncodedWasmFunctionBody
} from "#wasm/encoder/function-body.js";
import { emitFunctionRegions } from "./region.js";

export type FunctionEmitContext = Readonly<{
  bindings: ModuleBindings;
  placement: FunctionPlacement;
}>;

export function emitFunction(
  fn: IrFunction,
  context: FunctionEmitContext
): EncodedWasmFunctionBody {
  assert(context.placement.function === fn, "placement belongs to another IR function");

  return encodeWasmFunctionBody(
    {
      parameterCount: fn.parameters.length,
      localTypes: context.placement.plan.localTypes
    },
    (body, resolveLocal) => {
      emitFunctionRegions(fn, {
        body,
        bindings: context.bindings,
        placement: context.placement,
        resolveLocal
      });
    }
  );
}
