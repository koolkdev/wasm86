import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
import type { CellRef } from "#compiler/refs/cell.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { IrBlock } from "#ir/block.js";
import type { PlacementPlan } from "../model.js";
import type { PlacementProof } from "./uses.js";

type LocalClaim = Readonly<{
  local: number;
  start: SiteId;
  end: SiteId;
  owner: string;
}>;

export function validatePlacementLocals(
  block: IrBlock,
  analysis: BodyAnalysis,
  plan: PlacementPlan,
  proof: PlacementProof
): void {
  const claims: LocalClaim[] = [];
  const claimed = new Set<number>();
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
    claimed.add(local);
    claims.push({ local, start, end, owner });
  };

  for (const site of analysis.sites()) {
    if (site.kind !== "action" || site.action.kind !== "loop") {
      continue;
    }
    const end = analysis.bodyEndSite(site.action.body);

    for (const cell of site.action.carried) {
      const placement = plan.values[cell.loopInput];

      assert(placement?.kind === "loopInput", `loop input ${cell.loopInput} has no local`);
      claim(
        placement.local,
        block.values.valueType(cell.loopInput),
        site.id,
        end,
        `loop input ${cell.loopInput}`
      );
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

  claimCellLocals(analysis, plan, claim);

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
  for (let local = 0; local < plan.localTypes.length; local += 1) {
    assert(claimed.has(local), `local ${local} is never used`);
  }
}

// Cells claim through the same lifetime proof as value locals: seed to last
// access, held through any loop an access crosses into. The lifetime is
// recomputed here independently of the planner's ranges.
function claimCellLocals(
  analysis: BodyAnalysis,
  plan: PlacementPlan,
  claim: (
    local: number,
    type: ValueType,
    start: SiteId,
    end: SiteId,
    owner: string
  ) => void
): void {
  const seeds = new Map<CellRef, SiteId>();
  const accesses = new Map<CellRef, SiteId[]>();

  for (const { action, site } of analysis.operations()) {
    const operation = action.op;

    if (operation.kind !== "cell.read" && operation.kind !== "cell.write") {
      continue;
    }
    const sites = accesses.get(operation.cell);

    if (sites === undefined) {
      accesses.set(operation.cell, [site]);
    } else {
      sites.push(site);
    }
    if (operation.kind === "cell.write" && operation.initialization === "seed") {
      seeds.set(operation.cell, site);
    }
  }

  for (const cell of plan.cellLocals.keys()) {
    assert(accesses.has(cell), "cell local has no referenced cell");
  }

  let index = 0;

  for (const [cell, sites] of accesses) {
    const owner = `cell ${index}`;
    const local = plan.cellLocals.get(cell);
    const seed = seeds.get(cell);

    index += 1;
    assert(local !== undefined, "referenced cell has no local");
    assert(seed !== undefined, `${owner} has no seed in this block`);
    claim(
      local,
      cell.type,
      seed,
      cellLifetimeEnd(analysis, seed, sites, owner),
      owner
    );
  }
}

function cellLifetimeEnd(
  analysis: BodyAnalysis,
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
    const path = analysis.path(seedSite.body, accessSite.body);

    assert(path !== undefined, `${owner} access leaves its seed scope`);
    for (const step of path) {
      if (analysis.isLoopBody(step.body)) {
        const loopEnd = analysis.bodyEndSite(step.body);

        end = loopEnd > end ? loopEnd : end;
      }
    }
  }
  return end;
}

function valueLifetimeEnd(
  analysis: BodyAnalysis,
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
    const path = analysis.path(anchorSite.body, demandSite.body);

    assert(path !== undefined, `value ${value} demand leaves its anchor scope`);
    for (const step of path) {
      if (analysis.isLoopBody(step.body)) {
        const loopEnd = analysis.bodyEndSite(step.body);

        end = loopEnd > end ? loopEnd : end;
      }
    }
  }
  return end;
}
