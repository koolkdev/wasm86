import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/function/storage.js";
import { covers } from "#compiler/function/storage.js";
import type { FunctionRef } from "#compiler/reference.js";
import { BodyEvent, siteId } from "#compiler/wasm/function/body.js";
import type { WasmFunctionPlan } from "#compiler/wasm/plan/function.js";

type FunctionEffectDeclaration = Readonly<{
  ref: FunctionRef;
  effects: StorageEffects;
}>;

export function validateWasmFunctionEffectCoverage(
  fn: FunctionEffectDeclaration,
  plan: WasmFunctionPlan
): void {
  const required = collectRequiredEffects(plan);

  assertEffectsCovered(fn, "read", required.reads, fn.effects.reads);
  assertEffectsCovered(fn, "write", required.writes, fn.effects.writes);
}

function collectRequiredEffects(plan: WasmFunctionPlan): StorageEffects {
  const reads = new Set<StorageAccess>();
  const writes = new Set<StorageAccess>();

  for (const [rawSite, { event }] of plan.body.sites.entries()) {
    if (event.kind === "returnCall") {
      addExternalEffects(event.target.effects.reads, reads);
      addExternalEffects(event.target.effects.writes, writes);
      continue;
    }
    const description = BodyEvent.describe(event);

    if (description.category !== "operation") {
      continue;
    }
    const site = siteId(rawSite);

    if (
      plan.schedule.operationsAtAuthoredSite[site] === 0 &&
      (description.output === undefined ||
        plan.schedule.defaultEvaluations[description.output] === undefined)
    ) {
      continue;
    }
    addExternalEffects(description.effects.reads, reads);
    addExternalEffects(description.effects.writes, writes);
  }

  return { reads: [...reads], writes: [...writes] };
}

function addExternalEffects(accesses: readonly StorageAccess[], target: Set<StorageAccess>): void {
  for (const access of accesses) {
    if (access.kind === "resource") {
      target.add(access);
    }
  }
}

function assertEffectsCovered(
  fn: Pick<FunctionEffectDeclaration, "ref">,
  kind: "read" | "write",
  required: readonly StorageAccess[],
  declared: readonly StorageAccess[]
): void {
  for (const access of required) {
    assert(
      declared.some((candidate) => covers(candidate, access)),
      `function ${fn.ref.id} has an undeclared ${kind} effect`
    );
  }
}
