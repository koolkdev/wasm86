import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  planJitValueCacheSelection,
  type JitValueUseCount
} from "./value-cache-selection.js";
import {
  planJitValueCacheEpochs,
  type JitValueCacheInstruction,
  type JitValueCacheInstructionPlan,
  type JitValueCachePlanInput
} from "./value-cache-epochs.js";
import {
  type ValueUse
} from "./value-uses.js";

export type { JitValueUseCount } from "./value-cache-selection.js";
export type {
  JitValueCacheInstruction,
  JitValueCacheInstructionPlan,
  JitValueCachePlanInput
} from "./value-cache-epochs.js";

export type JitValueCachePlan = Readonly<{
  instructions: readonly JitValueCacheInstructionPlan[];
  definitionCaptures: readonly (readonly JitValue[])[];
  consumers: readonly (readonly JitValueUseCount[])[];
  useCounts: readonly JitValueUseCount[];
}>;

export function planJitValueCache(
  instruction: JitValueCacheInstruction,
  expressionBlock: IrExprBlock,
  valueUses: readonly ValueUse[]
): JitValueCachePlan {
  return planJitValueCacheForInstructions(
    [{ ...instruction, expressionBlock }],
    valueUses
  );
}

export function planJitValueCacheForInstructions(
  instructions: readonly JitValueCachePlanInput[],
  valueUses: readonly ValueUse[]
): JitValueCachePlan {
  const epoch = planJitValueCacheEpochs(instructions, valueUses);
  const selection = planJitValueCacheSelection(epoch.consumerUses);

  return {
    instructions: epoch.instructions,
    definitionCaptures: epoch.definitionCaptures,
    consumers: selection.consumers,
    useCounts: selection.useCounts
  };
}
