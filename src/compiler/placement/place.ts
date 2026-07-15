import { analyzeBody } from "#compiler/analysis/analyze.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { indexPlacement, type PlacementIndex } from "./index.js";
import type { PlacementPlan } from "./model.js";
import { planPlacement } from "./plan.js";

export type BodyPlacement = Readonly<{
  block: IrBlock;
  analysis: BodyAnalysis;
  plan: PlacementPlan;
  index: PlacementIndex;
}>;

export type BodyPlacementOptions = Readonly<{
  exportedOutputs?: Iterable<ValueId>;
  allowImplicitEntryFallthrough?: boolean;
}>;

// Validate the IR, analyze its body, plan value placement, and build the
// emitter's site index.
export function placeBody(
  block: IrBlock,
  options: BodyPlacementOptions = {}
): BodyPlacement {
  const exportedOutputs = [...(options.exportedOutputs ?? [])];

  validateIrBlock(block, {
    allowImplicitEntryFallthrough:
      options.allowImplicitEntryFallthrough === true,
    exportedOutputs
  });
  const analysis = analyzeBody(block, exportedOutputs);
  const plan = planPlacement(block, analysis);
  const index = indexPlacement(analysis, plan);

  return { block, analysis, plan, index };
}
