import { assert } from "#common/assert.js";
import {
  loopBlockInputs,
  siteIndexed,
  valueIndexed,
  type SiteId,
  type SiteIndexed,
  type ValueIndexed,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { WasmValueType } from "#wasm/types.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import type { EvaluationPlacement, EvaluationSweep, WasmEvaluation } from "./placement.js";
import type { WasmInstructionFusion } from "./fusion.js";
import { selectWasmInstructionFusion } from "./fusion.js";
import { allocateWasmLocals } from "./locals.js";

declare const evaluationIdBrand: unique symbol;

export type EvaluationId = number & {
  readonly [evaluationIdBrand]: "wasm-function-evaluation";
};

export function evaluationId(id: number): EvaluationId {
  return id as EvaluationId;
}

export type WasmSchedule = Readonly<{
  evaluations: readonly WasmEvaluation[];
  // Capture evaluations in selected order. Empty sites are undefined so
  // emission can replay the schedule without rebuilding it.
  captures: SiteIndexed<readonly EvaluationId[] | undefined>;
  // Values without a scheduled evaluation stay undefined.
  defaultEvaluations: ValueIndexed<EvaluationId | undefined>;
  // All uses of one value at a site share the selected evaluation.
  useOverrides: SiteIndexed<ReadonlyMap<WasmValueId, EvaluationId> | undefined>;
  // Physical schedule local -> value type.
  localTypes: readonly WasmValueType[];
  // Variables have their own mapping into the pooled physical locals. They
  // never overlap a live value temporary assigned to the same local.
  variableLocals: ReadonlyMap<VariableRef, number>;
  // Site-indexed operations that execute at their authored location rather
  // than through a live output evaluation.
  operationsAtAuthoredSite: Uint8Array;
}>;

type MutableWasmEvaluation = Omit<WasmEvaluation, "local" | "fusion"> & {
  local: number | undefined;
  fusion: WasmInstructionFusion | undefined;
};

type ScheduledEvaluationDraft = EvaluationPlacement & MutableWasmEvaluation;

export function evaluationForUse(
  schedule: WasmSchedule,
  value: WasmValueId,
  site: SiteId
): EvaluationId | undefined {
  return schedule.useOverrides[site]?.get(value) ?? schedule.defaultEvaluations[value];
}

// Loop inputs are appended after the sweep records, in loop-site order, so
// every earlier evaluation keeps the id its sweep position gave it.
export function buildWasmSchedule(body: WasmBody, sweep: EvaluationSweep): WasmSchedule {
  const placements = sweep.evaluations;
  const scheduled: ScheduledEvaluationDraft[] = placements.map((placement) => ({
    value: placement.value,
    anchor: placement.anchor,
    uses: placement.uses,
    isDefault: placement.isDefault,
    operationSite: placement.operationSite,
    kind: placement.kind,
    local: undefined,
    fusion: undefined
  }));
  const locals = allocateWasmLocals(body, scheduled);
  const evaluations: MutableWasmEvaluation[] = scheduled;
  const defaultEvaluations = valueIndexed<EvaluationId | undefined>(body.values.length, undefined);
  const useOverrides = siteIndexed<Map<WasmValueId, EvaluationId> | undefined>(
    body.sites.length,
    undefined
  );

  for (const [index, evaluation] of evaluations.entries()) {
    const id = evaluationId(index);

    assert(
      evaluation.kind === "atUse" || evaluation.local !== undefined,
      `${evaluation.kind} value ${evaluation.value} has no local`
    );
    if (evaluation.isDefault) {
      assert(
        defaultEvaluations[evaluation.value] === undefined,
        `value ${evaluation.value} has two default evaluations`
      );
      defaultEvaluations[evaluation.value] = id;
      continue;
    }

    for (const site of evaluation.uses) {
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

  for (const block of body.blocks) {
    if (!block.isLoop) {
      continue;
    }
    const site = block.ownerSite;

    assert(site !== undefined, "loop block has no owner");
    for (const loopInput of loopBlockInputs(body, block)) {
      const local = locals.loopInputLocals[loopInput];

      assert(
        defaultEvaluations[loopInput] === undefined,
        `loop input ${loopInput} is scheduled twice`
      );
      assert(local !== undefined, `loop input ${loopInput} has no local`);
      const id = evaluationId(evaluations.length);

      evaluations.push({
        value: loopInput,
        anchor: site,
        uses: noUses,
        isDefault: true,
        operationSite: undefined,
        kind: "loopInput",
        local,
        fusion: undefined
      });
      defaultEvaluations[loopInput] = id;
    }
  }

  const schedule: WasmSchedule = {
    evaluations,
    captures: scheduleCaptures(body, evaluations),
    defaultEvaluations,
    useOverrides,
    localTypes: locals.localTypes,
    variableLocals: locals.variableLocals,
    operationsAtAuthoredSite: sweep.operationsAtAuthoredSite
  };

  for (const [index, evaluation] of evaluations.entries()) {
    evaluation.fusion = selectWasmInstructionFusion(body, schedule, evaluationId(index));
  }
  return schedule;
}

function scheduleCaptures(
  body: WasmBody,
  evaluations: readonly WasmEvaluation[]
): SiteIndexed<readonly EvaluationId[] | undefined> {
  const captures = siteIndexed<EvaluationId[] | undefined>(body.sites.length, undefined);

  for (const [evaluationIndex, evaluation] of evaluations.entries()) {
    if (evaluation.kind !== "capture") {
      continue;
    }
    const id = evaluationId(evaluationIndex);
    const atSite = captures[evaluation.anchor];

    assert(
      body.sites[evaluation.anchor] !== undefined,
      `capture value ${evaluation.value} has unknown anchor ${evaluation.anchor}`
    );
    if (atSite === undefined) {
      captures[evaluation.anchor] = [id];
    } else {
      atSite.push(id);
    }
  }

  return captures;
}

const noUses: readonly SiteId[] = [];
