import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { IrBlock } from "#ir/block.js";
import { planValueAnchors } from "./anchors.js";
import { planLocals } from "./locals.js";
import type { PlacementPlan, ValuePlacement } from "./model.js";

export function planPlacement(
  block: IrBlock,
  analysis: BodyAnalysis
): PlacementPlan {
  const placements = planValueAnchors(block, analysis);
  const locals = planLocals(block, analysis, placements);
  const values = placements.map((placement, raw): ValuePlacement | undefined => {
    if (placement === undefined) {
      return undefined;
    }
    const value = valueId(raw);
    const local = locals.valueLocals[value];

    switch (placement.kind) {
      case "atUse":
        return { kind: "atUse", anchor: placement.anchor, local };
      case "capture":
      case "control":
        assert(local !== undefined, `${placement.kind} value ${value} has no local`);
        return { kind: placement.kind, anchor: placement.anchor, local };
    }
  });

  for (const site of analysis.sites()) {
    if (site.kind !== "action" || site.action.kind !== "loop") {
      continue;
    }
    for (const cell of site.action.carried) {
      const local = locals.valueLocals[cell.loopInput];

      assert(values[cell.loopInput] === undefined, `loop input ${cell.loopInput} is placed twice`);
      assert(local !== undefined, `loop input ${cell.loopInput} has no local`);
      values[cell.loopInput] = { kind: "loopInput", local };
    }
  }

  return {
    values,
    localTypes: locals.localTypes,
    variableLocals: locals.variableLocals
  };
}
