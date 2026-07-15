import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import type { IrBlock } from "#ir/block.js";
import type { PlannedValue } from "./anchors.js";

export type PlannedLocals = Readonly<{
  valueLocals: readonly (number | undefined)[];
  variableLocals: readonly (number | undefined)[];
  localTypes: readonly ValueType[];
}>;

type LocalClaim = {
  readonly type: ValueType;
  readonly start: SiteId;
  readonly end: SiteId;
  readonly order: number;
  local: number;
  assign(local: number): void;
};

export function planLocals(
  block: IrBlock,
  analysis: BodyAnalysis,
  placements: readonly (PlannedValue | undefined)[]
): PlannedLocals {
  const valueLocals = new Array<number | undefined>(block.values.size()).fill(undefined);
  const variableLocals: (number | undefined)[] = [];
  const claims: LocalClaim[] = [];
  let order = 0;

  for (const [raw, placement] of placements.entries()) {
    if (
      placement === undefined ||
      (placement.kind === "atUse" && analysis.useCount(valueId(raw)) === 1)
    ) {
      continue;
    }
    const value = valueId(raw);

    claims.push({
      type: block.values.valueType(value),
      start: placement.anchor,
      end: localLifetimeEnd(analysis, placement),
      order: order++,
      local: -1,
      assign(local) { valueLocals[value] = local; }
    });
  }

  for (const site of analysis.sites()) {
    if (site.kind !== "action" || site.action.kind !== "loop") {
      continue;
    }
    const end = analysis.bodyEndSite(site.action.body);

    for (const cell of site.action.carried) {
      assert(
        placements[cell.loopInput] === undefined,
        `loop input ${cell.loopInput} has two local claims`
      );
      claims.push({
        type: block.values.valueType(cell.loopInput),
        start: site.id,
        end,
        order: order++,
        local: -1,
        assign(local) { valueLocals[cell.loopInput] = local; }
      });
    }
  }

  const sites = analysis.sites();
  const firstSite = sites[0];
  const lastSite = sites[sites.length - 1];

  assert(firstSite !== undefined && lastSite !== undefined, "placement has no sites");
  const variables = new Set<number>();

  for (const { action } of analysis.operations()) {
    if (!analysis.opActionMustExecute(action)) {
      continue;
    }
    for (const access of [...action.op.effects.reads, ...action.op.effects.writes]) {
      if (access.space === "var") {
        variables.add(access.variable);
      }
    }
  }

  if (variables.size > 0) {
    variableLocals.length = Math.max(...variables) + 1;
    variableLocals.fill(undefined);
  }
  for (const variable of [...variables].sort((a, b) => a - b)) {
    claims.push({
      type: "i32",
      start: firstSite.id,
      end: lastSite.id,
      order: order++,
      local: -1,
      assign(local) { variableLocals[variable] = local; }
    });
  }

  return {
    valueLocals,
    variableLocals,
    localTypes: allocateLocals(claims)
  };
}

// A value captured outside a loop is not recomputed at the back edge. Keep
// its local through the repeated region even when its last static use appears
// early in the loop body's one emission walk.
function localLifetimeEnd(
  analysis: BodyAnalysis,
  placement: Pick<PlannedValue, "anchor" | "lastDemand">
): SiteId {
  const anchor = analysis.sites()[placement.anchor];
  const demand = analysis.sites()[placement.lastDemand];

  assert(anchor !== undefined, `unknown local anchor ${placement.anchor}`);
  assert(demand !== undefined, `unknown local demand ${placement.lastDemand}`);
  const path = analysis.path(anchor.body, demand.body);

  assert(path !== undefined, "local demand leaves its anchor scope");
  let end = placement.lastDemand;

  for (const step of path) {
    if (analysis.isLoopBody(step.body)) {
      const loopEnd = analysis.bodyEndSite(step.body);

      if (loopEnd > end) {
        end = loopEnd;
      }
    }
  }
  return end;
}

function allocateLocals(claims: LocalClaim[]): readonly ValueType[] {
  claims.sort((a, b) => a.start - b.start || a.order - b.order);
  const active: LocalClaim[] = [];
  const free = new Map<ValueType, number[]>();
  const localTypes: ValueType[] = [];

  for (const claim of claims) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const previous = active[index];

      assert(previous !== undefined, "missing active local claim");
      if (previous.end >= claim.start) {
        continue;
      }
      active.splice(index, 1);
      const available = free.get(previous.type) ?? [];

      available.push(previous.local);
      available.sort((a, b) => a - b);
      free.set(previous.type, available);
    }

    const available = free.get(claim.type);
    const local = available?.shift() ?? localTypes.length;

    if (local === localTypes.length) {
      localTypes.push(claim.type);
    } else {
      assert(localTypes[local] === claim.type, `local ${local} cannot change type`);
    }

    claim.local = local;
    claim.assign(local);
    active.push(claim);
  }

  return localTypes;
}
