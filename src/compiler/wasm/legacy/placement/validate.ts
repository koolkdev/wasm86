import { assert } from "#common/assert.js";
import type { FunctionAnalysis } from "#compiler/wasm/legacy/analysis/model.js";
import type { FunctionGraph } from "#compiler/wasm/legacy/function.js";
import type { PlacementPlan } from "./model.js";
import { validatePlacementGeometry } from "./validate/geometry.js";
import { validatePlacementLocals } from "./validate/locals.js";
import { validatePlacementUses } from "./validate/uses.js";

// Rebuild demands and local lifetimes independently from the planner.
// Capture safety uses the emitter's fixed ordering: captures run on ordinary
// site entry, but after direct operands at structured headers.
export function validatePlacement(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  plan: PlacementPlan
): void {
  assert(
    plan.values.length === block.values.size(),
    `placement has ${plan.values.length} entries for ${block.values.size()} values`
  );
  const proof = validatePlacementUses(block, analysis, plan);

  validatePlacementGeometry(block, analysis, plan, proof);
  validatePlacementLocals(block, analysis, plan, proof);
}
