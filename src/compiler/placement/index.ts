import { assert } from "#common/assert.js";
import type { FunctionAnalysis } from "#compiler/analysis/model.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { PlacementPlan } from "./model.js";

export type PlacementIndex = Readonly<{
  // SiteId-indexed capture deadlines. Empty sites stay undefined.
  captures: readonly (readonly ValueId[] | undefined)[];
}>;

export function indexPlacement(analysis: FunctionAnalysis, plan: PlacementPlan): PlacementIndex {
  const captures = new Array<ValueId[] | undefined>(analysis.sites().length);

  // Value ids are topological, so this scan also orders same-site captures
  // before any capture whose recipe can depend on them.
  for (const [raw, placement] of plan.values.entries()) {
    if (placement?.kind !== "capture") {
      continue;
    }
    const atSite = captures[placement.anchor];
    const value = valueId(raw);

    assert(
      analysis.sites()[placement.anchor]?.id === placement.anchor,
      `capture value ${value} has unknown anchor ${placement.anchor}`
    );
    if (atSite === undefined) {
      captures[placement.anchor] = [value];
    } else {
      atSite.push(value);
    }
  }

  return { captures };
}
