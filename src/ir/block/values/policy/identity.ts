import { definitionExpr } from "#ir/block/definitions.js";
import { rootsForBlockSites } from "#ir/block/roots.js";
import type { BlockTimelineSite } from "#ir/block/timeline.js";
import {
  buildExprGraph,
  type ExprGraph,
  type ExprNodeId
} from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { ProducedValue } from "../plan/produced.js";
import type {
  CellObservation,
  TimelineConstraints
} from "./constraints.js";
import {
  valueRootExpr,
  type ValueRoot
} from "../plan/roots.js";

declare const materializationValueIdentityBrand: unique symbol;

export type MaterializationValueIdentity = Readonly<{
  expr: ExprRef;
  id: ExprNodeId;
  readonly [materializationValueIdentityBrand]: "MaterializationValueIdentity";
}>;

export type ValueIdentity = Readonly<{
  graph: ExprGraph;
  cellObservationValueIds: ReadonlyMap<CellObservation, ExprNodeId>;
  materializationValuesByValueId: ReadonlyMap<ExprNodeId, MaterializationValueIdentity>;
}>;

export type ValueIdentityInput = Readonly<{
  constraints: TimelineConstraints;
  timeline?: readonly BlockTimelineSite[];
  valueRoots?: readonly ValueRoot[];
  producedValues?: readonly ProducedValue[];
  /** Expressions that may be used as materialization candidate values. Missing entries are planner bugs. */
  materializationValues: readonly ExprRef[];
}>;

export function buildValueIdentity(input: ValueIdentityInput): ValueIdentity {
  const expressions = collectIdentityExpressions(input);
  const graph = buildExprGraph(expressions);
  const cellObservationValueIds = new Map<CellObservation, ExprNodeId>();
  const materializationValuesByValueId = new Map<ExprNodeId, MaterializationValueIdentity>();

  for (const observation of input.constraints.cellObservations) {
    cellObservationValueIds.set(observation, graph.node(observation.value).id);
  }

  for (const value of input.materializationValues) {
    const id = graph.node(value).id;

    if (!materializationValuesByValueId.has(id)) {
      materializationValuesByValueId.set(id, materializationValueIdentity(value, id));
    }
  }

  return Object.freeze({
    graph,
    cellObservationValueIds: new Map(cellObservationValueIds),
    materializationValuesByValueId: new Map(materializationValuesByValueId)
  } satisfies ValueIdentity);
}

export function materializationCandidateIdentity(
  identity: ValueIdentity,
  value: ExprRef
): MaterializationValueIdentity {
  let id: ExprNodeId;

  try {
    id = identity.graph.node(value).id;
  } catch {
    throw undeclaredMaterializationValueError();
  }

  const candidate = identity.materializationValuesByValueId.get(id);

  if (candidate === undefined) {
    throw undeclaredMaterializationValueError();
  }

  return candidate;
}

export function cellObservationValueId(
  identity: ValueIdentity,
  observation: CellObservation
): ExprNodeId {
  const id = identity.cellObservationValueIds.get(observation);

  if (id === undefined) {
    throw new Error("cell observation is not present in value identity");
  }

  return id;
}

function materializationValueIdentity(
  expr: ExprRef,
  id: ExprNodeId
): MaterializationValueIdentity {
  return Object.freeze({
    expr,
    id
  }) as MaterializationValueIdentity;
}

function undeclaredMaterializationValueError(): Error {
  return new Error("materialization value expression was not declared in materializationValues");
}

function collectIdentityExpressions(input: ValueIdentityInput): readonly ExprRef[] {
  const expressions: ExprRef[] = [];

  for (const observation of input.constraints.cellObservations) {
    expressions.push(observation.value);
  }

  if (input.timeline !== undefined) {
    for (const root of rootsForBlockSites({ timeline: input.timeline })) {
      expressions.push(root.expr);
    }
  }

  if (input.valueRoots !== undefined) {
    for (const root of input.valueRoots) {
      expressions.push(valueRootExpr(root));
    }
  }

  if (input.producedValues !== undefined) {
    for (const produced of input.producedValues) {
      expressions.push(definitionExpr(produced.site.definition.result));
    }
  }

  expressions.push(...input.materializationValues);
  return expressions;
}
