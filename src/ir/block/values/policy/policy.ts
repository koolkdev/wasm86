import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  exprDepsForExpr,
  type ExprDeps
} from "#ir/block/expr-deps.js";
import type { SourceCell } from "#ir/block/source-cells.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { ProducedValue } from "../plan/produced.js";
import {
  programPoint,
  programPointAfter,
  programPointBefore,
  type CellObservation,
  type ProgramPoint,
  type ReadBarrier
} from "./constraints.js";
import {
  definitionReplayBarriersForDomain,
  sourceReadBarriersForCell,
  pathCoversInConstraints,
  coveredCellObservations as coveredCellObservationsInIndex
} from "./constraint-index.js";
import {
  materializationCandidateIdentity,
  cellObservationValueId
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
    }>;

export type MaterializationCandidate = Readonly<{
  cell: SourceCell;
  value: ExprRef;
  at: ProgramPoint;
}>;

export type MaterializationDecision =
  | Readonly<{
      kind: "available";
      covers: readonly CellObservation[];
    }>
  | Readonly<{
      kind: "blocked";
      by: MaterializationBlocker;
    }>;

export type MaterializationBlocker =
  | Readonly<{
      kind: "valueUnavailable";
      decision: Extract<AvailabilityDecision, { kind: "blocked" }>;
    }>
  | Readonly<{
      kind: "conflictingObservation";
      observation: CellObservation;
    }>;

export type UsableValue =
  | Readonly<{ kind: "sourceInput"; source: SourceCell }>
  | Readonly<{ kind: "definitionInput"; definition: BlockDefinitionId }>
  | Readonly<{ kind: "expr"; expr: ExprRef }>;

export function canUseValueAt(
  context: ValuePolicyContext,
  value: UsableValue,
  at: ProgramPoint
): AvailabilityDecision {
  return canUseValueAtWithSeen(valuePolicyContextState(context), value, at, new Set());
}

export function canMaterializeCellAt(
  context: ValuePolicyContext,
  candidate: MaterializationCandidate
): MaterializationDecision {
  const state = valuePolicyContextState(context);
  const value = materializationCandidateIdentity(state.identity, candidate.value);
  const valueDecision = canUseValueAtWithSeen(
    state,
    {
      kind: "expr",
      expr: candidate.value
    },
    candidate.at,
    new Set()
  );

  if (valueDecision.kind === "blocked") {
    return blockedByUnavailableValue(valueDecision);
  }

  const covered = coveredCellObservationsInIndex(
    state.constraintIndex,
    candidate.cell,
    candidate.at
  );
  const conflict = covered.find((observation) =>
    value.id !== cellObservationValueId(state.identity, observation)
  );

  return conflict === undefined
    ? Object.freeze({ kind: "available", covers: covered })
    : blockedByConflictingObservation(conflict);
}

export function coveredCellObservations(
  context: ValuePolicyContext,
  cell: SourceCell,
  at: ProgramPoint
): readonly CellObservation[] {
  return coveredCellObservationsInIndex(valuePolicyContextState(context).constraintIndex, cell, at);
}

function canUseValueAtWithSeen(
  context: ValuePolicyContextState,
  value: UsableValue,
  at: ProgramPoint,
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
  at: ProgramPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  return canUseExprDepsAt(context, exprDepsForExpr(expr), at, seenDefinitions);
}

function canUseExprDepsAt(
  context: ValuePolicyContextState,
  deps: ExprDeps,
  at: ProgramPoint,
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
  at: ProgramPoint,
  seenDefinitions: Set<BlockDefinitionId>
): AvailabilityDecision {
  if (seenDefinitions.has(produced.id)) {
    return available();
  }

  seenDefinitions.add(produced.id);

  const origin = programPoint(context.constraints.paths.root, produced.at, "at");
  const barrier = definitionReplayBarriersForDomain(context.constraintIndex, produced.access.barrierDomain).find((candidate) =>
      pathCoversInConstraints(context.constraintIndex, candidate.point.path, at.path) &&
      programPointAfter(candidate.point, origin) &&
      programPointBefore(candidate.point, at)
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
  at: ProgramPoint
): AvailabilityDecision {
  const barrier = sourceBarrierFor(source, at, context);

  return barrier === undefined
    ? available()
    : blockedByReadBarrier(barrier);
}

function sourceBarrierFor(
  source: SourceCell,
  at: ProgramPoint,
  context: ValuePolicyContextState
): ReadBarrier | undefined {
  return sourceReadBarriersForCell(context.constraintIndex, source).find((barrier) =>
      pathCoversInConstraints(context.constraintIndex, barrier.point.path, at.path) &&
      programPointBefore(barrier.point, at)
  );
}

function available(): AvailabilityDecision {
  return Object.freeze({ kind: "available" });
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

function blockedByConflictingObservation(
  observation: CellObservation
): MaterializationDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({
      kind: "conflictingObservation",
      observation
    })
  });
}

function blockedByUnavailableValue(
  decision: Extract<AvailabilityDecision, { kind: "blocked" }>
): MaterializationDecision {
  return Object.freeze({
    kind: "blocked",
    by: Object.freeze({
      kind: "valueUnavailable",
      decision
    })
  });
}
