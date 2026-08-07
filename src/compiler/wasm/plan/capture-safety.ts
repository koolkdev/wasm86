import { assert } from "#common/assert.js";
import {
  bodyEvent,
  eventOperands,
  type BodyEvent,
  type SiteId,
  type ValueDemand,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { dominatingSite } from "#compiler/wasm/function/geometry.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

export type CaptureUsePlacement = Readonly<{
  anchor: SiteId;
  hasLocal: boolean;
}>;

// Before choosing between one shared capture and path-local evaluations, use
// mandatory predecessor demands as the safety frontier already established at
// the capture point. Structured-control operands are included because the
// emitter evaluates them before captures at that header.
// The frontier is the seeds plus discoveries made before this value's visit,
// in discovery order.
export function canCaptureAfterMandatoryPredecessors(
  body: WasmBody,
  value: WasmValueId,
  site: SiteId,
  seeds: readonly ValueDemand[],
  discovered: readonly ValueDemand[]
): boolean {
  const available = new Set<WasmValueId>();
  const event = bodyEvent(body, site);

  for (const root of seeds) {
    addRoot(root);
  }
  for (const root of discovered) {
    addRoot(root);
  }
  if (hasNestedRegions(event)) {
    for (const operand of eventOperands(event)) {
      addExpression(operand);
    }
  }

  return canEvaluateSafely(body, value, (candidate) => available.has(candidate));

  function addRoot(root: ValueDemand): void {
    if (
      root.consumedAt !== site &&
      dominatingSite(body, [root.consumedAt, site]) === root.consumedAt
    ) {
      addExpression(root.value);
    }
  }

  function addExpression(root: WasmValueId): void {
    const pending = [root];

    while (pending.length !== 0) {
      const current = pending.pop();

      if (current === undefined || available.has(current)) {
        continue;
      }
      available.add(current);
      for (const input of body.values.node(current).inputs) {
        pending.push(input);
      }
    }
  }
}

// A capture at an ordinary site runs on entry. Structured headers first emit
// their operands, so captured computations may also replay assigned locals from
// those direct uses. The scheduler still owns the safety decision; the emitter
// only follows this fixed deadline.
export function canCaptureAtDeadline(
  body: WasmBody,
  value: WasmValueId,
  site: SiteId,
  placementForUse: (value: WasmValueId, consumedAt: SiteId) => CaptureUsePlacement | undefined,
  isAvailableAtCapture: (value: WasmValueId) => boolean
): boolean {
  const event = bodyEvent(body, site);

  if (!hasNestedRegions(event)) {
    return canEvaluateSafely(body, value, isAvailableAtCapture);
  }

  const bound = new Set<WasmValueId>();
  const visited = new Set<WasmValueId>();
  const pending: WasmValueId[] = [...eventOperands(event)];

  while (pending.length !== 0) {
    const operand = pending.pop();

    if (operand === undefined || visited.has(operand)) {
      continue;
    }
    visited.add(operand);
    const placement = placementForUse(operand, site);
    const anchor = placement?.anchor;

    if (anchor !== site) {
      if (
        anchor !== undefined &&
        placement !== undefined &&
        placement.hasLocal &&
        dominatingSite(body, [anchor, site]) === anchor
      ) {
        bound.add(operand);
      }
      continue;
    }

    const producer = body.producers[operand];
    const inputs =
      producer === undefined
        ? body.values.node(operand).inputs
        : eventOperands(bodyEvent(body, producer));

    for (const input of inputs) {
      pending.push(input);
    }
    if (placement !== undefined && placement.hasLocal) {
      bound.add(operand);
    }
  }

  return canEvaluateSafely(
    body,
    value,
    (candidate) => bound.has(candidate) || isAvailableAtCapture(candidate)
  );
}

function hasNestedRegions(event: BodyEvent): boolean {
  return event.kind === "if" || event.kind === "switch" || event.kind === "loop";
}

function canEvaluateSafely(
  body: WasmBody,
  value: WasmValueId,
  isBound: (value: WasmValueId) => boolean
): boolean {
  const safety = new Map<WasmValueId, boolean>();
  const pending = [value];

  while (pending.length !== 0) {
    const current = pending[pending.length - 1];

    assert(current !== undefined, "capture-safety stack lost its current value");
    if (safety.has(current)) {
      pending.pop();
      continue;
    }
    if (body.facts.recipeCanSpeculate(current) || isBound(current)) {
      safety.set(current, true);
      pending.pop();
      continue;
    }
    if (!body.facts.instructionCanSpeculate(current)) {
      safety.set(current, false);
      pending.pop();
      continue;
    }

    const inputs = body.values.node(current).inputs;
    let unresolved: WasmValueId | undefined;
    let safe = true;

    for (const input of inputs) {
      const inputSafety = safety.get(input);

      if (inputSafety === false) {
        safe = false;
        break;
      }
      if (inputSafety === undefined) {
        unresolved = input;
        break;
      }
    }

    if (!safe) {
      safety.set(current, false);
      pending.pop();
    } else if (unresolved !== undefined) {
      assert(unresolved < current, `Wasm input ${unresolved} must precede value ${current}`);
      pending.push(unresolved);
    } else {
      safety.set(current, true);
      pending.pop();
    }
  }

  const result = safety.get(value);

  assert(result !== undefined, `capture safety for value ${value} was not resolved`);
  return result;
}
