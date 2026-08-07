import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { FunctionRef } from "#compiler/reference.js";
import type { StorageAccess, StorageEffects } from "#compiler/function/storage.js";
import type { ResourceRef } from "#compiler/reference.js";
import {
  eventOutput,
  isOperationEvent,
  siteId,
  type BodyEvent,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { placeEvaluations } from "./placement.js";
import { buildWasmSchedule, type WasmSchedule } from "./schedule.js";
import { validateWasmSchedule } from "./validate.js";

// Symbolic dependencies of retained target instructions. These are neither
// every symbol mentioned by the source body nor encoded patch sites.
export type WasmFunctionDependencies = Readonly<{
  directCalls: readonly FunctionRef[];
  resources: readonly ResourceRef[];
}>;

export type WasmFunctionPlan = Readonly<{
  body: WasmBody;
  schedule: WasmSchedule;
  dependencies: WasmFunctionDependencies;
  directCallBindings: ReadonlyMap<FunctionRef, CallTarget>;
  // Declared function effects must cover these. Only validation reads them, so
  // only validation builds them.
  requiredEffects: StorageEffects | undefined;
}>;

// Fusions are decided after locals allocation: the guard rejects an input that
// already owns a local.
export function planWasmFunction(body: WasmBody): WasmFunctionPlan {
  const schedule = buildWasmSchedule(body, placeEvaluations(body));

  if (buildDefinition.validation) {
    validateWasmSchedule(body, schedule);
  }
  return collectDependencies(body, schedule);
}

// Live operation events in site order. Module indexing interns function types
// and orders functions by this first-use order.
function collectDependencies(body: WasmBody, schedule: WasmSchedule): WasmFunctionPlan {
  const directCalls: FunctionRef[] = [];
  const resources: ResourceRef[] = [];
  const knownDirectCalls = new Set<FunctionRef>();
  const directCallBindings = new Map<FunctionRef, CallTarget>();
  const knownResources = new Set<ResourceRef>();
  const effects = buildDefinition.validation
    ? { reads: new Set<StorageAccess>(), writes: new Set<StorageAccess>() }
    : undefined;

  const addTarget = (target: CallTarget): void => {
    addIdentity(directCalls, knownDirectCalls, target.ref);
    const existing = directCallBindings.get(target.ref);

    assert(
      existing === undefined || existing === target,
      `direct function ${target.ref.id} has multiple target objects`
    );
    directCallBindings.set(target.ref, target);
    if (effects !== undefined) {
      addExternalEffects(target.effects.reads, effects.reads);
      addExternalEffects(target.effects.writes, effects.writes);
    }
  };

  const addOperation = (event: BodyEvent): void => {
    switch (event.kind) {
      case "call":
        addTarget(event.target);
        return;
      case "load":
        addIdentity(resources, knownResources, event.effect.resource);
        effects?.reads.add(event.effect);
        return;
      case "store":
        addIdentity(resources, knownResources, event.effect.resource);
        effects?.writes.add(event.effect);
        return;
      default:
        return;
    }
  };

  for (const [index, event] of body.events.entries()) {
    if (!isOperationEvent(event)) {
      if (event.kind === "returnCall") {
        addTarget(event.target);
      }
      continue;
    }
    const site = siteId(index);
    const output = eventOutput(event);

    if (
      (output !== undefined && schedule.defaultEvaluations[output] !== undefined) ||
      schedule.operationsAtAuthoredSite[site] !== 0
    ) {
      addOperation(event);
    }
  }

  return {
    body,
    schedule,
    dependencies: { directCalls, resources },
    directCallBindings,
    requiredEffects:
      effects === undefined ? undefined : { reads: [...effects.reads], writes: [...effects.writes] }
  };
}

function addIdentity<Value>(values: Value[], known: Set<Value>, value: Value): void {
  if (known.has(value)) {
    return;
  }
  known.add(value);
  values.push(value);
}

function addExternalEffects(accesses: readonly StorageAccess[], target: Set<StorageAccess>): void {
  for (const access of accesses) {
    if (access.space === "resource") {
      target.add(access);
    }
  }
}
