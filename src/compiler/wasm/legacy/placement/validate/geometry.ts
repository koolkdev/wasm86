import { assert } from "#common/assert.js";
import type {
  FunctionAnalysis,
  Producer,
  RegionSite,
  SiteId
} from "#compiler/wasm/legacy/analysis/model.js";
import { describeNode } from "#compiler/ir/node.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { mayAlias } from "#compiler/ir/effects.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import { LoopAnchors } from "../loop-anchors.js";
import type { PlacementPlan } from "../model.js";
import type { PlacementProof } from "./uses.js";

export function validatePlacementGeometry(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  plan: PlacementPlan,
  proof: PlacementProof
): void {
  const loopAnchors = new LoopAnchors(block, analysis);

  for (let raw = 0; raw < block.values.size(); raw += 1) {
    const value = valueId(raw);
    const placement = plan.values[value];

    if (placement === undefined || placement.kind === "loopInput") {
      continue;
    }
    const anchor = placement.anchor;
    const demands = proof.demands[value]!;

    assert(demands.length > 0, `placed value ${value} has no demand`);
    for (const demand of demands) {
      assert(
        analysis.dominatingSite([anchor, demand.consumedAt]) === anchor,
        `value ${value} anchor does not dominate demand ${demand.consumedAt}`
      );
    }

    const producer = analysis.producer(value);

    if (producer !== undefined) {
      validateProducer(block, analysis, producer, anchor);
    } else if (analysis.controlProducer(value) === undefined) {
      validateComputed(analysis, loopAnchors, value, anchor, demands);
    }
  }
}

function validateComputed(
  analysis: FunctionAnalysis,
  loopAnchors: LoopAnchors,
  value: ValueId,
  anchor: SiteId,
  demands: PlacementProof["demands"][number]
): void {
  const floor = analysis.dominatingSite(demands.map((demand) => demand.consumedAt));

  assert(
    loopAnchors.allows(value, floor, anchor),
    `computed value ${value} has illegal anchor ${anchor} from ${floor}`
  );
}

function validateProducer(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  producer: Producer,
  anchorId: SiteId
): void {
  const authored = getSite(analysis, producer.site);
  const anchor = getSite(analysis, anchorId);
  const path =
    authored.region === anchor.region ? [] : analysis.path(authored.region, anchor.region);

  assert(authored.kind === "node", `producer ${producer.output} has no node site`);
  assert(path !== undefined, `producer ${producer.output} leaves its definition scope`);
  const description = describeNode(producer.operation);

  if (authored.region === anchor.region) {
    assert(
      anchor.nodeIndex >= authored.nodeIndex,
      `producer ${producer.output} is anchored before its definition`
    );
  } else {
    const first = path[0];

    assert(first !== undefined, `producer ${producer.output} has no placement path`);
    assert(
      getSite(analysis, first.owner).nodeIndex > authored.nodeIndex,
      `producer ${producer.output} enters a region before its definition`
    );
    for (const step of path) {
      assert(
        !analysis.isLoopRegion(step.region),
        `producer ${producer.output} moves from outside into a loop`
      );
    }
  }
  if (anchor.id !== authored.id) {
    assert(
      description.effects.writes.length === 0,
      `producer ${producer.output} moves an effectful realization`
    );
    assert(
      producer.inputs.every((input) => block.values.isNonTrapping(input)),
      `producer ${producer.output} moves a trapping realization`
    );
  }

  const reads = description.effects.reads;
  let region = authored.region;
  let start = authored.nodeIndex + 1;
  const stableThrough = (end: number): void => {
    for (let index = start; index < end; index += 1) {
      const writes = analysis.writesAt(analysis.siteOf(region, index));

      assert(
        !writes.some((write) => reads.some((read) => mayAlias(read, write))),
        `producer ${producer.output} crosses an aliasing write`
      );
    }
  };

  for (const step of path) {
    stableThrough(getSite(analysis, step.owner).nodeIndex);
    region = step.region;
    start = 0;
  }
  stableThrough(anchor.nodeIndex);
}

function getSite(analysis: FunctionAnalysis, id: SiteId): RegionSite {
  const site = analysis.sites()[id];

  assert(site !== undefined && site.id === id, `unknown placement site ${id}`);
  return site;
}
