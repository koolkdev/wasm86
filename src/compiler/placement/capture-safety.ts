import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { bodyFinal } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { actionOperands } from "#ir/traverse.js";

// A capture at an ordinary site runs on entry. Structured headers first emit
// their operands, so captured recipes may also replay locals materialized by
// those direct uses. The planner still owns the safety decision; the emitter
// only follows this fixed deadline.
export function canCaptureAtDeadline(
  block: IrBlock,
  analysis: BodyAnalysis,
  anchors: readonly (SiteId | undefined)[],
  value: ValueId,
  site: SiteId,
  hasLocal: (value: ValueId) => boolean,
  isAvailableAtCapture: (value: ValueId) => boolean
): boolean {
  const record = analysis.sites()[site];

  assert(record !== undefined, `unknown capture site ${site}`);
  if (
    record.kind !== "action" ||
    (record.action.kind !== "if" &&
      record.action.kind !== "switch" &&
      record.action.kind !== "loop")
  ) {
    return canEvaluateWithoutTrap(block, value, isAvailableAtCapture);
  }

  const bound = new Set<ValueId>();
  const visited = new Set<ValueId>();
  let headerIsUnreachable = false;
  const visitDirectUse = (operand: ValueId): void => {
    if (visited.has(operand)) {
      return;
    }
    visited.add(operand);
    if (block.values.isUnreachable(operand)) {
      headerIsUnreachable = true;
      return;
    }
    const mode = block.values.captureMode(operand);

    if (mode === "reemit") {
      return;
    }
    const anchor = anchors[operand];

    if (anchor !== site) {
      if (
        anchor !== undefined &&
        hasLocal(operand) &&
        analysis.dominatingSite([anchor, site]) === anchor
      ) {
        bound.add(operand);
      }
      return;
    }

    const producer = analysis.producer(operand);

    if (producer !== undefined) {
      for (const input of producer.inputs) {
        visitDirectUse(input);
      }
    } else if (mode === "compute") {
      for (const child of block.values.children(operand)) {
        visitDirectUse(child);
      }
    }

    if (hasLocal(operand)) {
      bound.add(operand);
    }
  };

  if (exportSite(block, analysis) === site) {
    for (const output of analysis.exportedOutputs()) {
      visitDirectUse(output);
    }
  }
  for (const operand of actionOperands(record.action)) {
    visitDirectUse(operand);
  }

  if (headerIsUnreachable) {
    return true;
  }

  return canEvaluateWithoutTrap(
    block,
    value,
    (candidate) => bound.has(candidate) || isAvailableAtCapture(candidate)
  );
}

function exportSite(block: IrBlock, analysis: BodyAnalysis): SiteId | undefined {
  if (analysis.exportedOutputs().length === 0) {
    return undefined;
  }
  return bodyFinal(block.body) === undefined
    ? analysis.bodyEndSite(block.body)
    : analysis.siteOf(block.body, block.body.actions.length - 1);
}

function canEvaluateWithoutTrap(
  block: IrBlock,
  value: ValueId,
  isBound: (value: ValueId) => boolean
): boolean {
  const safe = new Map<ValueId, boolean>();
  const visit = (current: ValueId): boolean => {
    const existing = safe.get(current);

    if (existing !== undefined) {
      return existing;
    }
    if (block.values.isNonTrapping(current) || isBound(current)) {
      safe.set(current, true);
      return true;
    }
    if (block.values.mayTrap(current)) {
      safe.set(current, false);
      return false;
    }
    const result = block.values.children(current).every(visit);

    safe.set(current, result);
    return result;
  };

  return visit(value);
}
