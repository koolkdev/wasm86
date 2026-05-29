import { planBoundaries } from "./boundaries.js";
import { planSourceCaptures } from "./captures.js";
import { planValues } from "./planned-values.js";
import { planProducedValues } from "./produced-values.js";
import type {
  BlockValuePlan,
  BlockValuePlanInput
} from "./types.js";

export type {
  BlockValuePlan,
  BlockValuePlanInput,
  PlannedBoundary,
  PlannedCapture,
  PlannedLifetime,
  PlannedProducedValue,
  PlannedValue,
  PlannedValueId
} from "./types.js";

export function planBlockValues(input: BlockValuePlanInput): BlockValuePlan {
  const values = planValues(input.sites);

  return Object.freeze({
    values,
    produced: planProducedValues(input.producedValues, input.sites),
    captures: planSourceCaptures(values, input.sourceEffects),
    boundaries: planBoundaries(input.sites)
  });
}
