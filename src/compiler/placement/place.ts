import { buildDefinition } from "#build";
import { analyzeBody } from "#compiler/analysis/analyze.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import { validateIrBlock, validateIrFunction } from "#ir/validate.js";
import { indexPlacement, type PlacementIndex } from "./index.js";
import type { PlacementPlan } from "./model.js";
import { planPlacement } from "./plan.js";
import { validatePlacement } from "./validate.js";

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

// Analyze an IR body, plan value placement, and build the emitter's site index.
export function placeBody(
  block: IrBlock,
  options: BodyPlacementOptions = {}
): BodyPlacement {
  const exportedOutputs = [...(options.exportedOutputs ?? [])];

  if (buildDefinition.validation) {
    validateIrBlock(block, {
      allowImplicitEntryFallthrough:
        options.allowImplicitEntryFallthrough === true,
      exportedOutputs
    });
  }
  return createPlacement(block, exportedOutputs);
}

export function placeFunction(fn: IrFunction): BodyPlacement {
  if (buildDefinition.validation) {
    validateIrFunction(fn);
  }
  return createPlacement(fn, []);
}

function createPlacement(
  block: IrBlock,
  exportedOutputs: readonly ValueId[]
): BodyPlacement {
  const analysis = analyzeBody(block, exportedOutputs);
  const plan = planPlacement(block, analysis);

  if (buildDefinition.validation) {
    validatePlacement(block, analysis, plan);
  }
  const index = indexPlacement(analysis, plan);

  return { block, analysis, plan, index };
}
