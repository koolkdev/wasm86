import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/function/storage.js";
import {
  bodyEvent,
  loopBlockInputs,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { blockPath, loopBoundary, siteRecord } from "#compiler/wasm/function/geometry.js";
import { wasmIntegerType } from "#compiler/wasm/type-lowering.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import type { WasmValueType } from "#wasm/types.js";
import type { EvaluationPlacement } from "./placement.js";

export type WasmLocalAllocation = Readonly<{
  loopInputLocals: readonly (number | undefined)[];
  variableLocals: ReadonlyMap<VariableRef, number>;
  localTypes: readonly WasmValueType[];
}>;

type EvaluationLocalTarget = EvaluationPlacement & { local: number | undefined };

type LocalClaimBase = {
  readonly type: WasmValueType;
  readonly start: SiteId;
  readonly end: SiteId;
  readonly order: number;
  local: number;
};

type LocalClaim = LocalClaimBase &
  (
    | Readonly<{
        owner: "evaluation";
        evaluation: EvaluationLocalTarget;
      }>
    | Readonly<{ owner: "loopInput"; loopInput: WasmValueId }>
    | Readonly<{ owner: "variable"; variable: VariableRef }>
  );

type EvaluationLifetime = Pick<EvaluationPlacement, "anchor" | "uses">;

export function allocateWasmLocals(
  body: WasmBody,
  evaluations: readonly EvaluationLocalTarget[]
): WasmLocalAllocation {
  const loopInputLocals = new Array<number | undefined>(body.values.length).fill(undefined);
  const variableLocals = new Map<VariableRef, number>();
  const claims: LocalClaim[] = [];
  let order = 0;

  for (const evaluation of evaluations) {
    if (evaluation.kind === "atUse" && evaluation.uses.length === 1) {
      continue;
    }

    claims.push({
      type: body.values.node(evaluation.value).type,
      start: evaluation.anchor,
      end: evaluationLocalEnd(body, evaluation),
      order: order++,
      local: -1,
      owner: "evaluation",
      evaluation
    });
  }

  // Loop blocks are opened in loop-site order, so their inputs claim in the
  // same order the sites do.
  for (const block of body.blocks) {
    if (!block.isLoop) {
      continue;
    }
    const site = block.ownerSite;

    assert(site !== undefined, "loop block has no owner");
    for (const loopInput of loopBlockInputs(body, block)) {
      claims.push({
        type: body.values.node(loopInput).type,
        start: site,
        end: block.closeSite,
        order: order++,
        local: -1,
        owner: "loopInput",
        loopInput
      });
    }
  }

  // Variables join the same pooled interval allocation as value temporaries.
  // Disjoint-lifetime variables share locals instead of accumulating one slot
  // per variable across a body.
  for (const [variable, lifetime] of variableLifetimes(body)) {
    claims.push({
      type: wasmIntegerType(variable.width),
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
        claim.evaluation.local = claim.local;
        break;
      case "loopInput":
        loopInputLocals[claim.loopInput] = claim.local;
        break;
      case "variable":
        variableLocals.set(claim.variable, claim.local);
        break;
    }
  }

  return {
    loopInputLocals,
    variableLocals,
    localTypes
  };
}

// The interval an evaluation holds its local across. Validation rebuilds the
// same interval to check the pooling.
export function evaluationLocalEnd(body: WasmBody, evaluation: EvaluationLifetime): SiteId {
  return localLifetimeEnd(body, evaluation.anchor, lastUse(evaluation.uses));
}

// A variable is live from its seed to its last access, widened across any loop
// an access crosses into: the back edge makes the stored value live for the
// whole loop. Earlier validation makes the seed dominate every access.
export function variableLifetimes(
  body: WasmBody
): Map<VariableRef, { start: SiteId; end: SiteId }> {
  const lifetimes = new Map<VariableRef, { start: SiteId; end: SiteId }>();

  for (const site of body.operationSites) {
    const operation = bodyEvent(body, site);

    if (operation.kind !== "variableRead" && operation.kind !== "variableWrite") {
      continue;
    }
    if (operation.kind === "variableWrite" && operation.seed) {
      lifetimes.set(operation.variable, { start: site, end: site });
      continue;
    }
    const lifetime = lifetimes.get(operation.variable);

    assert(lifetime !== undefined, "variable access has no seed in this body");
    const end = localLifetimeEnd(body, lifetime.start, site);

    if (end > lifetime.end) {
      lifetime.end = end;
    }
  }
  return lifetimes;
}

function lastUse(uses: readonly SiteId[]): SiteId {
  const first = uses[0];

  assert(first !== undefined, "a claiming evaluation has no uses");
  let result = first;

  for (const use of uses) {
    if (use > result) {
      result = use;
    }
  }
  return result;
}

// A value captured outside a loop is not recomputed at the back edge. Keep
// its local through the repeated region even when its last static use appears
// early in the loop block's one emission walk.
function localLifetimeEnd(body: WasmBody, anchorSite: SiteId, lastUseSite: SiteId): SiteId {
  const anchor = siteRecord(body, anchorSite);
  const demand = siteRecord(body, lastUseSite);
  const path = blockPath(body, anchor.block, demand.block);

  assert(path !== undefined, "local demand leaves its anchor scope");
  let end = lastUseSite;

  for (const step of path) {
    const loop = loopBoundary(body, step.block);

    if (loop !== undefined && loop.closeSite > end) {
      end = loop.closeSite;
    }
  }
  return end;
}

function allocateLocals(claims: LocalClaim[]): readonly WasmValueType[] {
  // Ties keep append order: finalize-order evaluations, then loop inputs, then
  // variables. A demand-position key would reorder mixed claim kinds at one
  // site — a lifted capture at a loop header against that loop's input claims.
  claims.sort((a, b) => a.start - b.start || a.order - b.order);
  const localTypes: WasmValueType[] = [];
  const localEnds: SiteId[] = [];

  for (const claim of claims) {
    let local = localTypes.findIndex(
      (type, index) => type === claim.type && localEnds[index]! < claim.start
    );

    if (local === -1) {
      local = localTypes.length;
    }

    if (local === localTypes.length) {
      localTypes.push(claim.type);
      localEnds.push(claim.end);
    } else {
      localEnds[local] = claim.end;
    }

    claim.local = local;
  }

  return localTypes;
}
