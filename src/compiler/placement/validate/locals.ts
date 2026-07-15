import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
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

  const variables = usedVariables(analysis);
  const expectedVariables = variables.size === 0 ? 0 : Math.max(...variables) + 1;

  assert(
    plan.variableLocals.length === expectedVariables,
    `placement has ${plan.variableLocals.length} variable locals, expected ${expectedVariables}`
  );
  const sites = analysis.sites();
  const first = sites[0];
  const last = sites[sites.length - 1];

  assert(first !== undefined && last !== undefined, "body analysis has no sites");
  for (let variable = 0; variable < plan.variableLocals.length; variable += 1) {
    const local = plan.variableLocals[variable];

    if (!variables.has(variable)) {
      assert(local === undefined, `unused variable ${variable} has a local`);
    } else {
      assert(local !== undefined, `variable ${variable} has no local`);
      claim(local, "i32", first.id, last.id, `variable ${variable}`);
    }
  }

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

function usedVariables(analysis: BodyAnalysis): Set<number> {
  const result = new Set<number>();

  for (const { action } of analysis.operations()) {
    if (!analysis.opActionMustExecute(action)) {
      continue;
    }
    for (const access of [...action.op.effects.reads, ...action.op.effects.writes]) {
      if (access.space === "var") {
        result.add(access.variable);
      }
    }
  }
  return result;
}
