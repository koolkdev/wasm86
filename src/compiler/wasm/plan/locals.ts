import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { siteId, type SiteId, type WasmBody } from "#compiler/wasm/function/body.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { toWasmValueType } from "#compiler/wasm/type-mapping.js";
import type { WasmValueType } from "#wasm/types.js";
import { WasmBodyIndex } from "./body-index.js";
import type { EvaluationPlacement, WasmPlacement } from "./placement.js";

type WasmLocalAllocation = Readonly<{
  // Indexed by position in the placement's evaluation list.
  evaluationLocals: readonly (number | undefined)[];
  // Loop inputs are inline values, so their locals are indexed directly by value id.
  loopInputLocals: readonly (number | undefined)[];
  variableLocals: ReadonlyMap<VariableRef, number>;
  localTypes: readonly WasmValueType[];
}>;

type LocalClaimBase = {
  readonly type: WasmValueType;
  readonly start: SiteId;
  readonly end: SiteId;
  readonly order: number;
  local: number;
};

type LocalClaim = LocalClaimBase &
  (
    | Readonly<{ owner: "evaluation"; evaluation: number }>
    | Readonly<{ owner: "loopInput"; loopInput: WasmValueId }>
    | Readonly<{ owner: "variable"; variable: VariableRef }>
  );

type EvaluationLifetime = Pick<EvaluationPlacement, "anchor" | "uses">;
type VariableLifetime = { start: SiteId; end: SiteId };

export function allocateWasmLocals(body: WasmBody, placement: WasmPlacement): WasmLocalAllocation {
  const index = new WasmBodyIndex(body);
  const evaluationLocals = new Array<number | undefined>(placement.evaluations.length).fill(
    undefined
  );
  const loopInputLocals = new Array<number | undefined>(body.values.length).fill(undefined);
  const variableLocals = new Map<VariableRef, number>();
  const claims: LocalClaim[] = [];
  let order = 0;

  for (const [evaluationIndex, evaluation] of placement.evaluations.entries()) {
    if (evaluation.kind === "atUse" && evaluation.uses.length === 1) {
      continue;
    }
    claims.push({
      type: body.values.node(evaluation.value).type,
      start: evaluation.anchor,
      end: evaluationLocalEnd(index, evaluation),
      order: order++,
      local: -1,
      owner: "evaluation",
      evaluation: evaluationIndex
    });
  }

  // Loop inputs claim after evaluations, in loop-site and input order.
  for (const [rawSite, site] of body.sites.entries()) {
    if (site.event.kind !== "loop") {
      continue;
    }
    const start = siteId(rawSite);
    const end = index.endSite(site.event.body);

    for (const input of site.event.inputs) {
      claims.push({
        type: body.values.node(input).type,
        start,
        end,
        order: order++,
        local: -1,
        owner: "loopInput",
        loopInput: input
      });
    }
  }

  // Variables share the same typed interval pool as evaluation temporaries.
  for (const [variable, lifetime] of variableLifetimes(body, placement, index)) {
    claims.push({
      type: toWasmValueType(variable.type),
      start: lifetime.start,
      end: lifetime.end,
      order: order++,
      local: -1,
      owner: "variable",
      variable
    });
  }

  const localTypes = allocateLocals(claims);

  for (const claim of claims) {
    switch (claim.owner) {
      case "evaluation":
        evaluationLocals[claim.evaluation] = claim.local;
        break;
      case "loopInput":
        assert(
          loopInputLocals[claim.loopInput] === undefined,
          `loop input ${claim.loopInput} has two locals`
        );
        loopInputLocals[claim.loopInput] = claim.local;
        break;
      case "variable":
        assert(!variableLocals.has(claim.variable), "variable has two locals");
        variableLocals.set(claim.variable, claim.local);
        break;
    }
  }

  return {
    evaluationLocals,
    loopInputLocals,
    variableLocals,
    localTypes
  };
}

function evaluationLocalEnd(index: WasmBodyIndex, evaluation: EvaluationLifetime): SiteId {
  return localLifetimeEnd(index, evaluation.anchor, lastUse(evaluation.uses));
}

// Authored accesses establish the stable baseline lifetime and local order.
// A live movable read may execute later, so its evaluation anchor extends that
// baseline without letting dead-read elimination perturb local numbering.
function variableLifetimes(
  body: WasmBody,
  placement: WasmPlacement,
  index: WasmBodyIndex
): Map<VariableRef, VariableLifetime> {
  const lifetimes = new Map<VariableRef, VariableLifetime>();

  for (const [rawSite, site] of body.sites.entries()) {
    const id = siteId(rawSite);
    const event = site.event;

    switch (event.kind) {
      case "variableWrite":
        assert(
          placement.operationsAtAuthoredSite[id] !== 0,
          "variable write is not retained at its authored site"
        );
        if (event.initialization === "seed") {
          assert(!lifetimes.has(event.variable), "variable has two retained seeds");
          lifetimes.set(event.variable, { start: id, end: id });
        } else {
          extendVariableLifetime(lifetimes, event.variable, id, index);
        }
        break;
      case "variableRead":
        extendVariableLifetime(lifetimes, event.variable, id, index);
        break;
      default:
        break;
    }
  }

  for (const evaluation of placement.evaluations) {
    const operationSite = evaluation.operationSite;

    if (operationSite === undefined) {
      continue;
    }
    const operation = index.site(operationSite).event;

    if (operation.kind === "variableRead") {
      extendVariableLifetime(lifetimes, operation.variable, evaluation.anchor, index);
    }
  }
  return lifetimes;
}

function extendVariableLifetime(
  lifetimes: Map<VariableRef, VariableLifetime>,
  variable: VariableRef,
  access: SiteId,
  index: WasmBodyIndex
): void {
  const lifetime = lifetimes.get(variable);

  assert(lifetime !== undefined, "variable access has no retained seed");
  const end = localLifetimeEnd(index, lifetime.start, access);

  if (end > lifetime.end) {
    lifetime.end = end;
  }
}

function lastUse(uses: readonly SiteId[]): SiteId {
  const first = uses[0];

  assert(first !== undefined, "a local evaluation has no uses");
  let result = first;

  for (const use of uses) {
    if (use > result) {
      result = use;
    }
  }
  return result;
}

// A local defined outside a loop survives its back edge even when its final
// static use appears near the beginning of the loop body's event-stream visit.
function localLifetimeEnd(index: WasmBodyIndex, anchor: SiteId, lastUseSite: SiteId): SiteId {
  const anchorBlock = index.site(anchor).block;
  const useBlock = index.site(lastUseSite).block;
  const path = index.path(anchorBlock, useBlock);

  assert(path !== undefined, "local use leaves its anchor scope");
  let end = lastUseSite;

  for (const step of path) {
    if (index.loopOwner(step.block) === undefined) {
      continue;
    }
    const loopEnd = index.endSite(step.block);

    if (loopEnd > end) {
      end = loopEnd;
    }
  }
  return end;
}

function allocateLocals(claims: LocalClaim[]): readonly WasmValueType[] {
  // Ties retain claim order: evaluations, loop inputs, then variables. This
  // order is part of deterministic local numbering and therefore code shape.
  claims.sort((a, b) => a.start - b.start || a.order - b.order);
  const localTypes: WasmValueType[] = [];
  const localEnds: SiteId[] = [];

  for (const claim of claims) {
    let local = localTypes.findIndex(
      (type, candidate) => type === claim.type && localEnds[candidate]! < claim.start
    );

    if (local === -1) {
      local = localTypes.length;
      localTypes.push(claim.type);
      localEnds.push(claim.end);
    } else {
      localEnds[local] = claim.end;
    }
    claim.local = local;
  }
  return localTypes;
}
