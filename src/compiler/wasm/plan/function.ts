import { assert } from "#common/assert.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { FunctionRef, ResourceRef } from "#compiler/reference.js";
import { BodyEvent, siteId, type WasmBody } from "#compiler/wasm/function/body.js";
import { placeEvaluations } from "./placement.js";
import { buildWasmSchedule, type WasmSchedule } from "./schedule.js";

// Retained dependencies stay in authored-site order. Module planning uses that
// order when it discovers functions and assigns target indices.
export type WasmFunctionDependencies = Readonly<{
  // Source targets let module reachability follow definitions; encoding uses their refs.
  directCalls: readonly CallTarget[];
  resources: readonly ResourceRef[];
}>;

export type WasmFunctionPlan = Readonly<{
  body: WasmBody;
  schedule: WasmSchedule;
  dependencies: WasmFunctionDependencies;
}>;

export function planWasmFunction(body: WasmBody): WasmFunctionPlan {
  const schedule = buildWasmSchedule(body, placeEvaluations(body));

  return {
    body,
    schedule,
    dependencies: collectDependencies(body, schedule)
  };
}

function collectDependencies(body: WasmBody, schedule: WasmSchedule): WasmFunctionDependencies {
  const directCalls: CallTarget[] = [];
  const resources: ResourceRef[] = [];
  const knownCalls = new Map<FunctionRef, CallTarget>();
  const knownResources = new Set<ResourceRef>();

  const addCall = (target: CallTarget): void => {
    const existing = knownCalls.get(target.ref);

    assert(
      existing === undefined || existing === target,
      `direct function ${target.ref.id} has multiple targets`
    );
    if (existing === undefined) {
      knownCalls.set(target.ref, target);
      directCalls.push(target);
    }
  };
  const addResource = (resource: ResourceRef): void => {
    if (!knownResources.has(resource)) {
      knownResources.add(resource);
      resources.push(resource);
    }
  };

  for (const [rawSite, { event }] of body.sites.entries()) {
    if (event.kind === "returnCall") {
      addCall(event.target);
      continue;
    }
    const site = siteId(rawSite);
    const description = BodyEvent.describe(event);

    if (
      description.category !== "operation" ||
      (schedule.operationsAtAuthoredSite[site] === 0 &&
        (description.output === undefined ||
          schedule.defaultEvaluations[description.output] === undefined))
    ) {
      continue;
    }

    switch (event.kind) {
      case "call":
        addCall(event.target);
        break;
      case "load":
      case "store":
        addResource(event.effect.resource);
        break;
      default:
        break;
    }
  }

  return { directCalls, resources };
}
