import { assert } from "#common/assert.js";
import type { FunctionAnalysis, SiteId, ValueDemand } from "#compiler/wasm/legacy/analysis/model.js";
import { describeNode } from "#compiler/ir/node.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import { canCaptureAtDeadline } from "../capture-safety.js";
import type { PlacementPlan, ValuePlacement } from "../model.js";

export type PlacementProof = Readonly<{
  demands: readonly (readonly ValueDemand[])[];
}>;

export function validatePlacementUses(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  plan: PlacementPlan
): PlacementProof {
  const demands = Array.from({ length: block.values.size() }, (): ValueDemand[] => []);
  const loopInputs = collectLoopInputs(analysis);
  const anchors = plan.values.map((placement) => placementAnchor(placement));
  const add = (demand: ValueDemand): void => {
    block.values.node(demand.value);
    demands[demand.value]!.push(demand);
  };

  for (const demand of analysis.roots()) {
    add(demand);
  }

  for (let raw = block.values.size() - 1; raw >= 0; raw -= 1) {
    const value = valueId(raw);
    const uses = demands[value]!;
    const placement = plan.values[value];

    assert(
      uses.length === analysis.useCount(value),
      `value ${value} has ${uses.length} demands, expected ${analysis.useCount(value)}`
    );
    validatePlacementShape(block, analysis, value, placement, loopInputs.has(value), uses);
    if (!analysis.isLive(value)) {
      assert(uses.length === 0, `dead value ${value} has placement demands`);
      continue;
    }

    const anchor = placementAnchor(placement);
    const producer = analysis.producer(value);

    if (producer !== undefined) {
      assert(anchor !== undefined, `producer ${value} has no anchor`);
      for (const input of producer.inputs) {
        add({ value: input, consumedAt: anchor });
      }
      continue;
    }

    const dependencies = analysis.controlDependencies(value);

    if (dependencies !== undefined) {
      for (const dependency of dependencies) {
        if (!block.values.isUnreachable(dependency.value)) {
          add(dependency);
        }
      }
      continue;
    }

    if (block.values.captureMode(value) === "compute") {
      assert(anchor !== undefined, `computed value ${value} has no anchor`);
      for (const child of block.values.children(value)) {
        add({ value: child, consumedAt: anchor });
      }
    }
  }

  for (let raw = 0; raw < block.values.size(); raw += 1) {
    const value = valueId(raw);
    const placement = plan.values[value];

    if (placement?.kind === "capture") {
      assert(
        canCaptureAtDeadline(
          block,
          analysis,
          anchors,
          value,
          placement.anchor,
          (candidate) => plan.values[candidate]?.local !== undefined,
          (candidate) => availableBefore(analysis, plan, candidate, value, placement.anchor)
        ),
        `capture ${value} may trap before a required operand is available`
      );
    }
  }
  return { demands };
}

function validatePlacementShape(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  value: ValueId,
  placement: ValuePlacement | undefined,
  loopInput: boolean,
  demands: readonly ValueDemand[]
): void {
  if (loopInput) {
    assert(placement?.kind === "loopInput", `loop input ${value} has no loop placement`);
    return;
  }

  const mode = block.values.captureMode(value);
  const needsPlacement = analysis.isLive(value) && (mode === "compute" || mode === "producer");

  assert(
    (placement !== undefined) === needsPlacement,
    needsPlacement
      ? `live computed value ${value} has no placement`
      : `value ${value} must not have a placement`
  );
  if (placement === undefined) {
    return;
  }
  assert(placement.kind !== "loopInput", `value ${value} is not a loop input`);
  const site = analysis.sites()[placement.anchor];

  assert(site !== undefined && site.id === placement.anchor, `unknown anchor ${placement.anchor}`);
  const control = analysis.controlProducer(value);

  if (control !== undefined) {
    assert(placement.kind === "control", `control output ${value} is not control-bound`);
    assert(placement.anchor === control.site, `control output ${value} has the wrong anchor`);
    return;
  }
  assert(placement.kind !== "control", `value ${value} has no control producer`);
  const direct = demands.some((demand) => demand.consumedAt === placement.anchor);

  assert(
    placement.kind === (direct ? "atUse" : "capture"),
    placement.kind === "atUse"
      ? `at-use value ${value} has no direct demand at ${placement.anchor}`
      : `captured value ${value} has a direct demand at ${placement.anchor}`
  );
  if (placement.kind === "atUse" && analysis.useCount(value) > 1) {
    assert(placement.local !== undefined, `multi-use value ${value} has no local`);
  }
}

function availableBefore(
  analysis: FunctionAnalysis,
  plan: PlacementPlan,
  candidate: ValueId,
  value: ValueId,
  anchor: SiteId
): boolean {
  const placement = plan.values[candidate];

  if (
    candidate >= value ||
    placement === undefined ||
    placement.local === undefined ||
    placement.kind === "loopInput"
  ) {
    return false;
  }
  if (placement.anchor === anchor) {
    return placement.kind === "capture";
  }
  return analysis.dominatingSite([placement.anchor, anchor]) === placement.anchor;
}

function collectLoopInputs(analysis: FunctionAnalysis): Set<ValueId> {
  const result = new Set<ValueId>();

  for (const site of analysis.sites()) {
    if (site.kind !== "node" || site.node.category === "operation") {
      continue;
    }

    const description = describeNode(site.node);

    for (const nested of description.nestedBodies) {
      if (nested.scope.kind === "loop") {
        for (const input of nested.scope.inputs) {
          result.add(input);
        }
      }
    }
  }
  return result;
}

function placementAnchor(placement: ValuePlacement | undefined): SiteId | undefined {
  return placement === undefined || placement.kind === "loopInput" ? undefined : placement.anchor;
}
