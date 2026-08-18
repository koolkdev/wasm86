import { buildFunction, type FunctionBuilder } from "#compiler/function/builder/function.js";
import type { FunctionType } from "#compiler/function/type.js";
import type { FunctionRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import type { PlannedWasmFunction } from "#compiler/wasm/module/plan.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { toWasmFunctionType } from "#compiler/wasm/type-mapping.js";

export function plannedFunction<Type extends FunctionType>(
  ref: FunctionRef,
  type: Type,
  build: (fn: FunctionBuilder<Type>) => void
): PlannedWasmFunction {
  return {
    ref,
    type: toWasmFunctionType(type),
    plan: planWasmFunction(lowerWasmFunction(buildFunction(type, build)))
  };
}
