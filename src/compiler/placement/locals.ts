import { assert } from "#common/assert.js";
import type { FunctionAnalysis, SiteId } from "#compiler/analysis/model.js";
import { describeNode } from "#compiler/ir/node.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { PlannedValue } from "./anchors.js";

export type PlannedLocals = Readonly<{
  valueLocals: readonly (number | undefined)[];
  variableLocals: ReadonlyMap<VariableRef, number>;
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
  block: FunctionGraph,
  analysis: FunctionAnalysis,
  placements: readonly (PlannedValue | undefined)[]
): PlannedLocals {
  const valueLocals = new Array<number | undefined>(block.values.size()).fill(undefined);
  const variableLocals = new Map<VariableRef, number>();
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
      assign(local) {
        valueLocals[value] = local;
      }
    });
  }

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
        assert(placements[input] === undefined, `loop input ${input} has two local claims`);
        claims.push({
          type: block.values.valueType(input),
          start: site.id,
          end,
          order: order++,
          local: -1,
          assign(local) {
            valueLocals[input] = local;
          }
        });
      }
    }
  }

  // Variables join the same pooled interval allocation as value temporaries.
  // Disjoint-lifetime variables share locals instead of accumulating one slot
  // per variable across a block.
  for (const [variable, lifetime] of variableLifetimes(analysis)) {
    claims.push({
      type: variable.type,
      start: lifetime.start,
      end: lifetime.end,
      order: order++,
      local: -1,
      assign(local) {
        variableLocals.set(variable, local);
      }
    });
  }

  return {
    valueLocals,
    variableLocals,
    localTypes: allocateLocals(claims)
  };
}

// A variable is live from its seed to its last access, widened across any loop
// an access crosses into: the back edge makes the stored value live for the
// whole loop. Seed dominance (IR-validated) makes the seed the range start.
function variableLifetimes(
  analysis: FunctionAnalysis
): Map<VariableRef, { start: SiteId; end: SiteId }> {
  const seeds = new Map<VariableRef, SiteId>();
  const accesses: { variable: VariableRef; site: SiteId }[] = [];

  for (const { operation, site } of analysis.operations()) {
    if (operation.kind !== "variable.read" && operation.kind !== "variable.write") {
      continue;
    }
    accesses.push({ variable: operation.variable, site });
    if (operation.kind === "variable.write" && operation.initialization === "seed") {
      seeds.set(operation.variable, site);
    }
  }

  const lifetimes = new Map<VariableRef, { start: SiteId; end: SiteId }>();

  for (const { variable, site } of accesses) {
    const seed = seeds.get(variable);

    assert(seed !== undefined, "variable access has no seed in this block");
    const end = localLifetimeEnd(analysis, { anchor: seed, lastDemand: site });
    const lifetime = lifetimes.get(variable);

    if (lifetime === undefined) {
      lifetimes.set(variable, { start: seed, end });
    } else if (end > lifetime.end) {
      lifetime.end = end;
    }
  }
  return lifetimes;
}

// A value captured outside a loop is not recomputed at the back edge. Keep
// its local through the repeated region even when its last static use appears
// early in the loop region's one emission walk.
function localLifetimeEnd(
  analysis: FunctionAnalysis,
  placement: Pick<PlannedValue, "anchor" | "lastDemand">
): SiteId {
  const anchor = analysis.sites()[placement.anchor];
  const demand = analysis.sites()[placement.lastDemand];

  assert(anchor !== undefined, `unknown local anchor ${placement.anchor}`);
  assert(demand !== undefined, `unknown local demand ${placement.lastDemand}`);
  const path = analysis.path(anchor.region, demand.region);

  assert(path !== undefined, "local demand leaves its anchor scope");
  let end = placement.lastDemand;

  for (const step of path) {
    if (analysis.isLoopRegion(step.region)) {
      const loopEnd = analysis.regionEndSite(step.region);

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
