import { buildDefinition } from "#build";
import { analyzeBody } from "#compiler/analysis/analyze.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import { validateIrFunction } from "#ir/validate.js";
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

export function placeFunction(fn: IrFunction): BodyPlacement {
  if (buildDefinition.validation) {
    validateIrFunction(fn);
  }
  return createPlacement(fn);
}

function createPlacement(block: IrBlock): BodyPlacement {
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);

  if (buildDefinition.validation) {
    validatePlacement(block, analysis, plan);
  }
  const index = indexPlacement(analysis, plan);

  return { block, analysis, plan, index };
}
