import { assert } from "#common/assert.js";
import { loopBlockInputs, type SiteId, type WasmBody } from "#compiler/wasm/function/body.js";
import { dominatingSite } from "#compiler/wasm/function/geometry.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmValueSource } from "#compiler/wasm/function/values/nodes.js";
import { canCaptureAtDeadline } from "./capture-safety.js";
import { demandedBefore, type WasmEvaluation } from "./placement.js";
import { evaluationLocalEnd, variableLifetimes } from "./locals.js";
import { evaluationForUse, type EvaluationId, type WasmSchedule } from "./schedule.js";

type LocalInterval = Readonly<{ local: number; start: SiteId; end: SiteId }>;

// The four properties a miscompile needs and the positional types cannot state.
// Everything else the schedule promises is structural or is placement itself.
export function validateWasmSchedule(body: WasmBody, schedule: WasmSchedule): void {
  validateAnchorDominance(body, schedule);
  validateLocalIntervals(body, schedule);
  validateCaptureDeadlines(body, schedule);
  validateFusionClaims(schedule);
}

// An anchor that does not dominate a recorded use evaluates the value on a path
// that use cannot reach.
function validateAnchorDominance(body: WasmBody, schedule: WasmSchedule): void {
  for (const [id, evaluation] of schedule.evaluations.entries()) {
    if (evaluation.kind === "loopInput") {
      continue;
    }
    for (const use of evaluation.uses) {
      assert(
        dominatingSite(body, [evaluation.anchor, use]) === evaluation.anchor,
        `evaluation ${id} anchor ${evaluation.anchor} does not dominate its use ${use}`
      );
    }
  }
}

// Two live intervals in one local would have the later claim overwrite a value
// the earlier one still reads back.
function validateLocalIntervals(body: WasmBody, schedule: WasmSchedule): void {
  const intervals = localIntervals(body, schedule);

  intervals.sort((a, b) => a.local - b.local || a.start - b.start);
  for (const [index, interval] of intervals.entries()) {
    const previous = intervals[index - 1];

    if (previous === undefined || previous.local !== interval.local) {
      continue;
    }
    assert(
      previous.end < interval.start,
      `local ${interval.local} is claimed at site ${interval.start} while live through ${previous.end}`
    );
  }
}

function localIntervals(body: WasmBody, schedule: WasmSchedule): LocalInterval[] {
  const intervals: LocalInterval[] = [];

  for (const evaluation of schedule.evaluations) {
    const { local } = evaluation;

    if (local === undefined || evaluation.kind === "loopInput") {
      continue;
    }
    intervals.push({ local, start: evaluation.anchor, end: evaluationLocalEnd(body, evaluation) });
  }

  for (const block of body.blocks) {
    if (!block.isLoop) {
      continue;
    }
    const start = block.ownerSite;

    assert(start !== undefined, "loop block has no owner");
    for (const loopInput of loopBlockInputs(body, block)) {
      const local = evaluationOf(schedule, schedule.defaultEvaluations[loopInput])?.local;

      assert(local !== undefined, `loop input ${loopInput} has no local`);
      intervals.push({ local, start, end: block.closeSite });
    }
  }

  for (const [variable, lifetime] of variableLifetimes(body)) {
    const local = schedule.variableLocals.get(variable);

    assert(local !== undefined, "scheduled variable has no local");
    intervals.push({ local, start: lifetime.start, end: lifetime.end });
  }
  return intervals;
}

// Captures flush at the emitter's fixed deadline: ordinary sites on entry, but
// structured headers only after their direct operands. A capture that needs a
// value not yet available there emits it out of order.
function validateCaptureDeadlines(body: WasmBody, schedule: WasmSchedule): void {
  for (const [id, evaluation] of schedule.evaluations.entries()) {
    if (evaluation.kind !== "capture") {
      continue;
    }
    const { anchor, value } = evaluation;

    assert(
      canCaptureAtDeadline(
        body,
        value,
        anchor,
        (candidate, consumedAt) => {
          const other = placedEvaluation(body, schedule, candidate, consumedAt);

          return other === undefined
            ? undefined
            : { anchor: other.anchor, hasLocal: other.local !== undefined };
        },
        (candidate) => availableBeforeCapture(body, schedule, candidate, value, anchor)
      ),
      `capture evaluation ${id} cannot speculate before a required operand is available`
    );
  }
}

// A local already assigned at a dominating anchor replays at the capture; one
// assigned at this same site only replays when it is itself an earlier capture.
function availableBeforeCapture(
  body: WasmBody,
  schedule: WasmSchedule,
  candidate: WasmValueId,
  value: WasmValueId,
  anchor: SiteId
): boolean {
  const other = demandedBefore(candidate, value)
    ? placedEvaluation(body, schedule, candidate, anchor)
    : undefined;

  if (other?.local === undefined) {
    return false;
  }
  return other.anchor === anchor
    ? other.kind === "capture"
    : dominatingSite(body, [other.anchor, anchor]) === other.anchor;
}

// A fused evaluation is emitted by its fusion, so two fuses claiming one
// input would emit that input twice.
function validateFusionClaims(schedule: WasmSchedule): void {
  const claimed = new Uint8Array(schedule.evaluations.length);

  for (const evaluation of schedule.evaluations) {
    const fusion = evaluation.fusion;

    if (fusion === undefined) {
      continue;
    }
    assert(
      claimed[fusion.inputEvaluation] === 0,
      `evaluation ${fusion.inputEvaluation} is fused more than once`
    );
    claimed[fusion.inputEvaluation] = 1;
  }
}

// Inline values and loop inputs are materialized by the emitter itself, so they
// place nowhere.
function placedEvaluation(
  body: WasmBody,
  schedule: WasmSchedule,
  value: WasmValueId,
  site: SiteId
): WasmEvaluation | undefined {
  if (wasmValueSource(body.values.node(value)) === "inline") {
    return undefined;
  }
  const evaluation = evaluationOf(schedule, evaluationForUse(schedule, value, site));

  return evaluation?.kind === "loopInput" ? undefined : evaluation;
}

function evaluationOf(
  schedule: WasmSchedule,
  id: EvaluationId | undefined
): WasmEvaluation | undefined {
  return id === undefined ? undefined : schedule.evaluations[id];
}
