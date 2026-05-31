import { analyzeValueRoots } from "./analysis.js";
import { planValues } from "./planned.js";
import { planProducedValues } from "./produced.js";
import type {
  BlockValuePlan,
  BlockValuePlanInput
} from "./types.js";

export type {
  BlockValuePlan,
  BlockValuePlanInput,
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
    produced: planProducedValues(input.producedValues, analyses)
  });
}
