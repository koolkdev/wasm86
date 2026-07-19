import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
import type { CellRef } from "#compiler/refs/cell.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import type { IrBlock } from "#ir/block.js";
import type { PlannedValue } from "./anchors.js";

export type PlannedLocals = Readonly<{
  valueLocals: readonly (number | undefined)[];
  cellLocals: ReadonlyMap<CellRef, number>;
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
  const cellLocals = new Map<CellRef, number>();
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
    if (site.kind !== "node" || site.node.category === "operation") {
      continue;
    }

    for (const nested of site.node.nestedBodies) {
      if (nested.scope.kind !== "loop") {
        continue;
      }
      const end = analysis.bodyEndSite(nested.body);

      for (const input of nested.scope.inputs) {
        assert(
          placements[input] === undefined,
          `loop input ${input} has two local claims`
        );
        claims.push({
          type: block.values.valueType(input),
          start: site.id,
          end,
          order: order++,
          local: -1,
          assign(local) { valueLocals[input] = local; }
        });
      }
    }
  }

  // Cells join the same pooled interval allocation as value temporaries, so
  // disjoint-lifetime cells share locals instead of accumulating one slot per
  // cell across a block. A future IR optimization may still remove or fold
  // accesses before placement without adding cell policy to emission.
  for (const [cell, lifetime] of cellLifetimes(analysis)) {
    claims.push({
      type: cell.type,
      start: lifetime.start,
      end: lifetime.end,
      order: order++,
      local: -1,
      assign(local) { cellLocals.set(cell, local); }
    });
  }

  return {
    valueLocals,
    cellLocals,
    localTypes: allocateLocals(claims)
  };
}

// A cell is live from its seed to its last access, widened across any loop an
// access crosses into: the back edge makes the stored value live for the whole
// loop. Seed dominance (IR-validated) makes the seed the range start.
function cellLifetimes(
  analysis: BodyAnalysis
): Map<CellRef, { start: SiteId; end: SiteId }> {
  const seeds = new Map<CellRef, SiteId>();
  const accesses: { cell: CellRef; site: SiteId }[] = [];

  for (const { operation, site } of analysis.operations()) {
    if (operation.kind !== "cell.read" && operation.kind !== "cell.write") {
      continue;
    }
    accesses.push({ cell: operation.cell, site });
    if (operation.kind === "cell.write" && operation.initialization === "seed") {
      seeds.set(operation.cell, site);
    }
  }

  const lifetimes = new Map<CellRef, { start: SiteId; end: SiteId }>();

  for (const { cell, site } of accesses) {
    const seed = seeds.get(cell);

    assert(seed !== undefined, "cell access has no seed in this block");
    const end = localLifetimeEnd(analysis, { anchor: seed, lastDemand: site });
    const lifetime = lifetimes.get(cell);

    if (lifetime === undefined) {
      lifetimes.set(cell, { start: seed, end });
    } else if (end > lifetime.end) {
      lifetime.end = end;
    }
  }
  return lifetimes;
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
