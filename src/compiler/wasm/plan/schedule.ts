import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { SiteId, WasmBody } from "#compiler/wasm/function/body.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import type { WasmValueType } from "#wasm/types.js";
import { allocateWasmLocals } from "./locals.js";
import type { WasmPlacement } from "./placement.js";

declare const evaluationIdBrand: unique symbol;

export type EvaluationId = number & {
  readonly [evaluationIdBrand]: "wasm-function-evaluation";
};

function evaluationId(id: number): EvaluationId {
  return id as EvaluationId;
}

export type WasmEvaluation = Readonly<{
  value: WasmValueId;
  anchor: SiteId;
  operationSite: SiteId | undefined;
  kind: "atUse" | "capture" | "join";
  local: number | undefined;
}>;

export type WasmSchedule = Readonly<{
  evaluations: readonly WasmEvaluation[];
  // Capture evaluations in their placement order at each anchor.
  captures: readonly (readonly EvaluationId[] | undefined)[];
  // Values without a default scheduled evaluation remain undefined.
  defaultEvaluations: readonly (EvaluationId | undefined)[];
  // A nondefault path-local evaluation overrides the default at its uses.
  useOverrides: readonly (ReadonlyMap<WasmValueId, EvaluationId> | undefined)[];
  // Loop inputs are inline values rather than scheduled evaluations.
  loopInputLocals: readonly (number | undefined)[];
  localTypes: readonly WasmValueType[];
  variableLocals: ReadonlyMap<VariableRef, number>;
  // Operations retained for their writes execute at their authored site.
  operationsAtAuthoredSite: Uint8Array;
}>;

export function evaluationForUse(
  schedule: WasmSchedule,
  value: WasmValueId,
  site: SiteId
): EvaluationId | undefined {
  return schedule.useOverrides[site]?.get(value) ?? schedule.defaultEvaluations[value];
}

// Finalization adds physical locals and the direct lookups emission needs; it
// does not reconsider placement or turn inline loop inputs into evaluations.
export function buildWasmSchedule(body: WasmBody, placement: WasmPlacement): WasmSchedule {
  const locals = allocateWasmLocals(body, placement);
  const evaluations: WasmEvaluation[] = placement.evaluations.map((evaluation, index) => ({
    value: evaluation.value,
    anchor: evaluation.anchor,
    operationSite: evaluation.operationSite,
    kind: evaluation.kind,
    local: locals.evaluationLocals[index]
  }));
  const captures = new Array<EvaluationId[] | undefined>(body.sites.length).fill(undefined);
  const defaultEvaluations = new Array<EvaluationId | undefined>(body.values.length).fill(
    undefined
  );
  const useOverrides = new Array<Map<WasmValueId, EvaluationId> | undefined>(
    body.sites.length
  ).fill(undefined);

  for (const [index, evaluation] of evaluations.entries()) {
    const id = evaluationId(index);
    const placed = placement.evaluations[index];

    assert(placed !== undefined, `evaluation ${index} has no placement`);
    assert(
      evaluation.local !== undefined || (evaluation.kind === "atUse" && placed.uses.length === 1),
      `${evaluation.kind} value ${evaluation.value} has no local`
    );
    if (placed.isDefault) {
      assert(
        defaultEvaluations[evaluation.value] === undefined,
        `value ${evaluation.value} has two default evaluations`
      );
      defaultEvaluations[evaluation.value] = id;
    } else {
      for (const site of placed.uses) {
        const overrides = useOverrides[site] ?? new Map<WasmValueId, EvaluationId>();
        const previous = overrides.get(evaluation.value);

        assert(
          previous === undefined || previous === id,
          `value ${evaluation.value} has two evaluations at site ${site}`
        );
        overrides.set(evaluation.value, id);
        useOverrides[site] = overrides;
      }
    }

    if (evaluation.kind === "capture") {
      const atAnchor = captures[evaluation.anchor];

      assert(
        body.sites[evaluation.anchor] !== undefined,
        `capture value ${evaluation.value} has unknown anchor ${evaluation.anchor}`
      );
      if (atAnchor === undefined) {
        captures[evaluation.anchor] = [id];
      } else {
        atAnchor.push(id);
      }
    }
  }

  return {
    evaluations,
    captures,
    defaultEvaluations,
    useOverrides,
    loopInputLocals: locals.loopInputLocals,
    localTypes: locals.localTypes,
    variableLocals: locals.variableLocals,
    operationsAtAuthoredSite: placement.operationsAtAuthoredSite
  };
}
