import { assert } from "#common/assert.js";
import type { BodyAnalysis, BodySite, Producer, SiteId } from "#compiler/analysis/model.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { mayAlias } from "#ir/aliasing.js";
import type { IrBlock } from "#ir/block.js";
import { actionOutput } from "#ir/traverse.js";
import { LoopAnchors } from "../loop-anchors.js";
import type { PlacementPlan } from "../model.js";
import type { PlacementProof } from "./uses.js";

export function validatePlacementGeometry(
  block: IrBlock,
  analysis: BodyAnalysis,
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
  analysis: BodyAnalysis,
  loopAnchors: LoopAnchors,
  value: ValueId,
  anchor: SiteId,
  demands: PlacementProof["demands"][number]
): void {
  const floor = analysis.dominatingSite(
    demands.map((demand) => demand.consumedAt)
  );

  assert(
    loopAnchors.allows(value, floor, anchor),
    `computed value ${value} has illegal anchor ${anchor} from ${floor}`
  );
}

function validateProducer(
  block: IrBlock,
  analysis: BodyAnalysis,
  producer: Producer,
  anchorId: SiteId
): void {
  const authored = getSite(analysis, producer.site);
  const anchor = getSite(analysis, anchorId);
  const path = authored.body === anchor.body
    ? []
    : analysis.path(authored.body, anchor.body);

  assert(authored.kind === "action", `producer ${producer.output} has no action site`);
  assert(path !== undefined, `producer ${producer.output} leaves its definition scope`);
  if (authored.body === anchor.body) {
    assert(
      anchor.actionIndex >= authored.actionIndex,
      `producer ${producer.output} is anchored before its definition`
    );
  } else {
    const first = path[0];

    assert(first !== undefined, `producer ${producer.output} has no placement path`);
    assert(
      getSite(analysis, first.owner).actionIndex > authored.actionIndex,
      `producer ${producer.output} enters a region before its definition`
    );
    for (const step of path) {
      assert(
        !analysis.isLoopBody(step.body),
        `producer ${producer.output} moves from outside into a loop`
      );
    }
  }
  if (anchor.id !== authored.id) {
    assert(
      producer.inputs.every((input) => block.values.isNonTrapping(input)),
      `producer ${producer.output} moves a trapping realization`
    );
  }

  const reads = producer.action.op.effects.reads;
  let body = authored.body;
  let start = authored.actionIndex + 1;
  const stableThrough = (end: number): void => {
    for (let index = start; index < end; index += 1) {
      const writes = analysis.writesAt(analysis.siteOf(body, index));

      assert(
        !writes.some((write) => reads.some((read) => mayAlias(read, write))),
        `producer ${actionOutput(producer.action)} crosses an aliasing write`
      );
    }
  };

  for (const step of path) {
    stableThrough(getSite(analysis, step.owner).actionIndex);
    body = step.body;
    start = 0;
  }
  stableThrough(anchor.actionIndex);
}

function getSite(analysis: BodyAnalysis, id: SiteId): BodySite {
  const site = analysis.sites()[id];

  assert(site !== undefined && site.id === id, `unknown placement site ${id}`);
  return site;
}
