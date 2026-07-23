import { buildDefinition } from "#build";
import { analyzeFunction } from "#compiler/analysis/analyze.js";
import type { FunctionAnalysis } from "#compiler/analysis/model.js";
import type { IrFunction } from "#compiler/ir/function.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { indexPlacement, type PlacementIndex } from "./index.js";
import type { PlacementPlan } from "./model.js";
import { planPlacement } from "./plan.js";
import { validatePlacement } from "./validate.js";

export type FunctionPlacement = Readonly<{
  function: IrFunction;
  analysis: FunctionAnalysis;
  plan: PlacementPlan;
  index: PlacementIndex;
}>;

export function placeFunction(fn: IrFunction): FunctionPlacement {
  if (buildDefinition.validation) {
    validateIrFunction(fn);
  }
  return createPlacement(fn);
}

function createPlacement(fn: IrFunction): FunctionPlacement {
  const analysis = analyzeFunction(fn);
  const plan = planPlacement(fn, analysis);

  if (buildDefinition.validation) {
    validatePlacement(fn, analysis, plan);
  }
  const index = indexPlacement(analysis, plan);

  return { function: fn, analysis, plan, index };
}
