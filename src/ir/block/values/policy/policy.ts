import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  exprDepsForExpr,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import {
  sourceCellsOverlap,
  type SourceCell
} from "#ir/block/source-cells.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { ProducedValue } from "../plan/produced.js";
import {
  pathPoint,
  pathPointAfter,
  pathPointBefore,
  pathPointBeforeOrAt,
  type CellValueTarget,
  type CellWrite,
  type PathPoint,
  type ReadBarrier
} from "./constraints.js";
import {
  cellValueTargetsForCell,
  cellWritesForCell,
  definitionReplayBarriersForDomain,
  sourceReadBarriersForCell,
  pathCoversInConstraints
} from "./constraint-index.js";
import {
  storeCandidateIdentity,
  cellValueTargetValueId,
  type StoreCandidateIdentity
} from "./identity.js";
import {
  producedValueForDefinition,
  valuePolicyContextState,
  type ValuePolicyContext,
  type ValuePolicyContextState
} from "./context.js";

export type AvailabilityDecision =
  | Readonly<{ kind: "available" }>
  | Readonly<{
      kind: "blocked";
      by: AvailabilityBlocker;
    }>;

export type AvailabilityBlocker =
  | Readonly<{
      kind: "readBarrier";
      barrier: ReadBarrier;
    }>
  | Readonly<{
      kind: "cellWrite";
      write: CellWrite;
    }>
  | Readonly<{
      kind: "cellValueTarget";
      target: CellValueTarget;
    }>
  | Readonly<{ kind: "pathNotCovered" }>;

export type UsableValue =
  | Readonly<{ kind: "sourceInput"; source: SourceCell }>
  | Readonly<{ kind: "definitionInput"; definition: BlockDefinitionId }>
  | Readonly<{ kind: "expr"; expr: ExprRef }>;

export function canUseValueAt(
  context: ValuePolicyContext,
  value: UsableValue,
  at: PathPoint
): AvailabilityDecision {
  return canUseValueAtWithSeen(valuePolicyContextState(context), value, at, new Set());
}

export function canWriteCellValueTargetAt(
  context: ValuePolicyContext,
  target: CellValueTarget,
  value: ExprRef,
  writeAt: PathPoint
): AvailabilityDecision {
  const state = valuePolicyContextState(context);
  const candidate = storeCandidateIdentity(state.identity, value);

  const placementDecision = checkStorePlacement(state, target, writeAt);

  if (placementDecision !== undefined) {
    return placementDecision;
  }

  const targetDecision = checkStoreTargetValue(state, target, candidate);

  if (targetDecision !== undefined) {
    return targetDecision;
  }

  const valueDecision = checkStoreValueAvailability(state, value, writeAt);

  if (valueDecision !== undefined) {
    return valueDecision;
  }

  const conflictingTarget = conflictingCellValueTargetForStore(state, target, candidate, writeAt);

  if (conflictingTarget !== undefined) {
    return blockedByCellValueTarget(conflictingTarget);
  }

  const write = interveningWriteForStore(state, target, writeAt);

  return write === undefined
    ? available()
    : blockedByCellWrite(write);
}

function checkStorePlacement(
  context: ValuePolicyContextState,
  target: CellValueTarget,
  storeAt: PathPoint
): AvailabilityDecision | undefined {
  const observedAt = target.point;

  // If storeAt is on another path, for example the opposite branch exit, the target will never see it.
  if (!pathCoversInConstraints(context.constraintIndex, storeAt.path, observedAt.path)) {
    return blockedByPath();
  }

  // If the write happens after the target point, it is too late to satisfy that target.
  return pathPointAfter(storeAt, observedAt)
    ? blockedByPath()
    : undefined;
}

function checkStoreTargetValue(
  context: ValuePolicyContextState,
  target: CellValueTarget,
  value: StoreCandidateIdentity
): AvailabilityDecision | undefined {
  const targetValueId = cellValueTargetValueId(context.identity, target);

  // The target says which value its cell must contain; reject a write of any other value.
  return value.id === targetValueId
    ? undefined
    : blockedByCellValueTarget(target);
}

function checkStoreValueAvailability(
  context: ValuePolicyContextState,
  value: ExprRef,
  storeAt: PathPoint
): AvailabilityDecision | undefined {
  const decision = canUseValueAtWithSeen(
    context,
    {
      kind: "expr",
      expr: value
    },
    storeAt,
    new Set()
  );

  return decision.kind === "blocked"
    ? decision
    : undefined;
}

function conflictingCellValueTargetForStore(
  context: ValuePolicyContextState,
  target: CellValueTarget,
  value: StoreCandidateIdentity,
  storeAt: PathPoint
): CellValueTarget | undefined {
  const cell = target.cell;
  const observedAt = target.point;

  // An earlier overlapping target would also see this write, so it must want the same value.
  return cellValueTargetsForCell(context.constraintIndex, cell).find((candidate) =>
    sourceCellsOverlap(candidate.cell, cell) &&
      candidate !== target &&
      value.id !== cellValueTargetValueId(context.identity, candidate) &&
      pathCoversInConstraints(context.constraintIndex, storeAt.path, candidate.point.path) &&
      !pathPointBefore(candidate.point, storeAt) &&
      pathPointBeforeOrAt(candidate.point, observedAt)
  );
}

function interveningWriteForStore(
  context: ValuePolicyContextState,
  target: CellValueTarget,
  storeAt: PathPoint
): CellWrite | undefined {
  const cell = target.cell;
  const observedAt = target.point;

  // A real same-cell write before target would overwrite this write before target sees it.
  return cellWritesForCell(context.constraintIndex, cell).find((candidate) =>
    sourceCellsOverlap(candidate.cell, cell) &&
      pathCoversInConstraints(context.constraintIndex, candidate.point.path, observedAt.path) &&
      pathPointAfter(candidate.point, storeAt) &&
      pathPointBeforeOrAt(candidate.point, observedAt)
  );
}

function canUseValueAtWithSeen(
  context: ValuePolicyContextState,
  value: UsableValue,
  at: PathPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  switch (value.kind) {
    case "sourceInput":
      return canUseSourceCellAt(context, value.source, at);
    case "definitionInput":
      return canUseProducedValueAt(
        context,
        producedValueForDefinition(context, value.definition),
        at,
        seenDefinitions
      );
    case "expr":
      return canUseExprAt(context, value.expr, at, seenDefinitions);
  }
}

function canUseExprAt(
  context: ValuePolicyContextState,
  expr: ExprRef,
  at: PathPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  return canUseExprDepsAt(context, exprDepsForExpr(expr), at, seenDefinitions);
}

function canUseExprDepsAt(
  context: ValuePolicyContextState,
  deps: ExprDeps,
  at: PathPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  for (const source of deps.sourceCells) {
    const decision = canUseSourceCellAt(context, source, at);

    if (decision.kind === "blocked") {
      return decision;
    }
  }

  for (const definition of deps.definitionIds) {
    const decision = canUseProducedValueAt(
      context,
      producedValueForDefinition(context, definition),
      at,
      seenDefinitions
    );

    if (decision.kind === "blocked") {
      return decision;
    }
  }

  return available();
}

function canUseProducedValueAt(
  context: ValuePolicyContextState,
  produced: ProducedValue,
  at: PathPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  if (seenDefinitions.has(produced.id)) {
    return available();
  }

  seenDefinitions.add(produced.id);

  const origin = pathPoint(context.constraints.paths.root, produced.at, "at");
  const barrier = definitionReplayBarriersForDomain(context.constraintIndex, produced.access.barrierDomain).find((candidate) =>
      pathCoversInConstraints(context.constraintIndex, candidate.point.path, at.path) &&
      pathPointAfter(candidate.point, origin) &&
      pathPointBefore(candidate.point, at)
  );

  if (barrier !== undefined) {
    seenDefinitions.delete(produced.id);
    return blockedByReadBarrier(barrier);
  }

  const inputDecision = canUseExprDepsAt(
    context,
    exprDepsForExpr(produced.access.input),
    at,
    seenDefinitions
  );

  seenDefinitions.delete(produced.id);
  return inputDecision;
}

function canUseSourceCellAt(
  context: ValuePolicyContextState,
  source: SourceCell,
  at: PathPoint
): AvailabilityDecision {
  const barrier = sourceBarrierFor(source, at, context);

  return barrier === undefined
    ? available()
    : blockedByReadBarrier(barrier);
}

function sourceBarrierFor(
  source: SourceCell,
  at: PathPoint,
  context: ValuePolicyContextState
): ReadBarrier | undefined {
  return sourceReadBarriersForCell(context.constraintIndex, source).find((barrier) =>
      pathCoversInConstraints(context.constraintIndex, barrier.point.path, at.path) &&
      pathPointBefore(barrier.point, at)
  );
}

function available(): AvailabilityDecision {
  return Object.freeze({ kind: "available" });
}

function blockedByPath(): AvailabilityDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({ kind: "pathNotCovered" })
  });
}

function blockedByReadBarrier(
  barrier: ReadBarrier
): AvailabilityDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({
      kind: "readBarrier",
      barrier
    })
  });
}

function blockedByCellWrite(
  write: CellWrite
): AvailabilityDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({
      kind: "cellWrite",
      write
    })
  });
}

function blockedByCellValueTarget(
  target: CellValueTarget
): AvailabilityDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({
      kind: "cellValueTarget",
      target
    })
  });
}
