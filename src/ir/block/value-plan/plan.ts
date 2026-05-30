import { planBoundaries } from "./boundaries.js";
import { planValues } from "./planned-values.js";
import { planProducedValues } from "./produced-values.js";
import { analyzeValueRoots } from "./root-analysis.js";
import type {
  BlockValuePlan,
  BlockValuePlanInput
} from "./types.js";

export type {
  BlockValuePlan,
  BlockValuePlanInput,
  PlannedBoundary,
  PlannedLifetime,
  PlannedProducedValue,
  PlannedValue,
  PlannedValueId
} from "./types.js";

export function planBlockValues(input: BlockValuePlanInput): BlockValuePlan {
  const analyses = analyzeValueRoots(input.graph, input.valueRoots);
  const values = planValues(analyses);

  return Object.freeze({
    values,
    produced: planProducedValues(input.producedValues, analyses),
    boundaries: planBoundaries(input.valueRoots)
  });
}
