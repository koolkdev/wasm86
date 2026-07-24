import { assert } from "#common/assert.js";
import type { FunctionAnalysis, SiteId } from "#compiler/analysis/model.js";
import { describeNode } from "#compiler/ir/node.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { PlacementPlan } from "../model.js";
import type { PlacementProof } from "./uses.js";

type LocalClaim = Readonly<{
  local: number;
  start: SiteId;
  end: SiteId;
  owner: string;
}>;

export function validatePlacementLocals(
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  plan: PlacementPlan,
  proof: PlacementProof
): void {
  const claims: LocalClaim[] = [];
  const claim = (
    local: number,
    type: ValueType,
    start: SiteId,
    end: SiteId,
    owner: string
  ): void => {
    assert(Number.isInteger(local) && local >= 0, `${owner} has invalid local ${local}`);
    assert(plan.localTypes[local] !== undefined, `${owner} uses missing local ${local}`);
    assert(plan.localTypes[local] === type, `${owner} has the wrong type in local ${local}`);
    assert(start <= end, `${owner} has reversed lifetime ${start}..${end}`);
    claims.push({ local, start, end, owner });
  };

  for (const site of analysis.sites()) {
    if (site.kind !== "node" || site.node.category === "operation") {
      continue;
    }

    const description = describeNode(site.node);

    for (const nested of description.nestedBodies) {
      if (nested.scope.kind !== "loop") {
        continue;
      }
      const end = analysis.regionEndSite(nested.body);

      for (const input of nested.scope.inputs) {
        const placement = plan.values[input];

        assert(placement?.kind === "loopInput", `loop input ${input} has no local`);
        claim(
          placement.local,
          block.values.valueType(input),
          site.id,
          end,
          `loop input ${input}`
        );
      }
    }
  }

  for (let raw = 0; raw < block.values.size(); raw += 1) {
    const value = valueId(raw);
    const placement = plan.values[value];

    if (
      placement === undefined ||
      placement.kind === "loopInput" ||
      placement.local === undefined
    ) {
      continue;
    }
    claim(
      placement.local,
      block.values.valueType(value),
      placement.anchor,
      valueLifetimeEnd(analysis, proof, value, placement.anchor),
      `value ${value}`
    );
  }

  claimVariableLocals(analysis, plan, claim);

  for (let left = 0; left < claims.length; left += 1) {
    const a = claims[left]!;

    for (let right = left + 1; right < claims.length; right += 1) {
      const b = claims[right]!;

      if (a.local === b.local) {
        assert(
          a.end < b.start || b.end < a.start,
          `${a.owner} and ${b.owner} overlap in local ${a.local}`
        );
      }
    }
  }
}

// Variables claim through the same lifetime proof as value locals: seed to last
// access, held through any loop an access crosses into. The lifetime is
// recomputed here independently of the planner's ranges.
function claimVariableLocals(
  analysis: FunctionAnalysis,
  plan: PlacementPlan,
  claim: (
    local: number,
    type: ValueType,
    start: SiteId,
    end: SiteId,
    owner: string
  ) => void
): void {
  const seeds = new Map<VariableRef, SiteId>();
  const accesses = new Map<VariableRef, SiteId[]>();

  for (const { operation, site } of analysis.operations()) {
    if (
      operation.kind !== "variable.read" &&
      operation.kind !== "variable.write"
    ) {
      continue;
    }
    const sites = accesses.get(operation.variable);

    if (sites === undefined) {
      accesses.set(operation.variable, [site]);
    } else {
      sites.push(site);
    }
    if (
      operation.kind === "variable.write" &&
      operation.initialization === "seed"
    ) {
      seeds.set(operation.variable, site);
    }
  }

  let index = 0;

  for (const [variable, sites] of accesses) {
    const owner = `variable ${index}`;
    const local = plan.variableLocals.get(variable);
    const seed = seeds.get(variable);

    index += 1;
    assert(local !== undefined, "referenced variable has no local");
    assert(seed !== undefined, `${owner} has no seed in this block`);
    claim(
      local,
      variable.type,
      seed,
      variableLifetimeEnd(analysis, seed, sites, owner),
      owner
    );
  }
}

function variableLifetimeEnd(
  analysis: FunctionAnalysis,
  seed: SiteId,
  accesses: readonly SiteId[],
  owner: string
): SiteId {
  const seedSite = analysis.sites()[seed];

  assert(seedSite !== undefined, `${owner} has unknown seed site ${seed}`);
  let end = seed;

  for (const access of accesses) {
    const accessSite = analysis.sites()[access];

    assert(accessSite !== undefined, `${owner} has unknown access site ${access}`);
    end = access > end ? access : end;
    const path = analysis.path(seedSite.region, accessSite.region);

    assert(path !== undefined, `${owner} access leaves its seed scope`);
    for (const step of path) {
      if (analysis.isLoopRegion(step.region)) {
        const loopEnd = analysis.regionEndSite(step.region);

        end = loopEnd > end ? loopEnd : end;
      }
    }
  }
  return end;
}

function valueLifetimeEnd(
  analysis: FunctionAnalysis,
  proof: PlacementProof,
  value: ValueId,
  anchor: SiteId
): SiteId {
  const anchorSite = analysis.sites()[anchor];

  assert(anchorSite !== undefined, `value ${value} has unknown anchor ${anchor}`);
  let end = anchor;

  for (const demand of proof.demands[value]!) {
    const demandSite = analysis.sites()[demand.consumedAt];

    assert(demandSite !== undefined, `value ${value} has unknown demand ${demand.consumedAt}`);
    end = demand.consumedAt > end ? demand.consumedAt : end;
    const path = analysis.path(anchorSite.region, demandSite.region);

    assert(path !== undefined, `value ${value} demand leaves its anchor scope`);
    for (const step of path) {
      if (analysis.isLoopRegion(step.region)) {
        const loopEnd = analysis.regionEndSite(step.region);

        end = loopEnd > end ? loopEnd : end;
      }
    }
  }
  return end;
}
