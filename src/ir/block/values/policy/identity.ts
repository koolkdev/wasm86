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
  CellValueTarget,
  TimelineConstraints
} from "./constraints.js";
import {
  valueRootExpr,
  type ValueRoot
} from "../plan/roots.js";

declare const storeCandidateIdentityBrand: unique symbol;

export type StoreCandidateIdentity = Readonly<{
  expr: ExprRef;
  id: ExprNodeId;
  readonly [storeCandidateIdentityBrand]: "StoreCandidateIdentity";
}>;

export type ValueIdentity = Readonly<{
  graph: ExprGraph;
  cellValueTargetValueIds: ReadonlyMap<CellValueTarget, ExprNodeId>;
  storeCandidatesByValueId: ReadonlyMap<ExprNodeId, StoreCandidateIdentity>;
}>;

export type ValueIdentityInput = Readonly<{
  constraints: TimelineConstraints;
  timeline?: readonly BlockTimelineSite[];
  valueRoots?: readonly ValueRoot[];
  producedValues?: readonly ProducedValue[];
  /** Expressions that may be queried by canWriteCellValueTargetAt. Missing entries are planner bugs. */
  storeCandidates: readonly ExprRef[];
}>;

export function buildValueIdentity(input: ValueIdentityInput): ValueIdentity {
  const expressions = collectIdentityExpressions(input);
  const graph = buildExprGraph(expressions);
  const cellValueTargetValueIds = new Map<CellValueTarget, ExprNodeId>();
  const storeCandidatesByValueId = new Map<ExprNodeId, StoreCandidateIdentity>();

  for (const target of input.constraints.cellValueTargets) {
    cellValueTargetValueIds.set(target, graph.node(target.value).id);
  }

  for (const value of input.storeCandidates) {
    const id = graph.node(value).id;

    if (!storeCandidatesByValueId.has(id)) {
      storeCandidatesByValueId.set(id, storeCandidateIdentityValue(value, id));
    }
  }

  return Object.freeze({
    graph,
    cellValueTargetValueIds: new Map(cellValueTargetValueIds),
    storeCandidatesByValueId: new Map(storeCandidatesByValueId)
  } satisfies ValueIdentity);
}

export function storeCandidateIdentity(
  identity: ValueIdentity,
  value: ExprRef
): StoreCandidateIdentity {
  let id: ExprNodeId;

  try {
    id = identity.graph.node(value).id;
  } catch {
    throw undeclaredStoreCandidateError();
  }

  const candidate = identity.storeCandidatesByValueId.get(id);

  if (candidate === undefined) {
    throw undeclaredStoreCandidateError();
  }

  return candidate;
}

export function cellValueTargetValueId(
  identity: ValueIdentity,
  target: CellValueTarget
): ExprNodeId {
  const id = identity.cellValueTargetValueIds.get(target);

  if (id === undefined) {
    throw new Error("cell value target is not present in value identity");
  }

  return id;
}

function storeCandidateIdentityValue(
  expr: ExprRef,
  id: ExprNodeId
): StoreCandidateIdentity {
  return Object.freeze({
    expr,
    id
  }) as StoreCandidateIdentity;
}

function undeclaredStoreCandidateError(): Error {
  return new Error("store candidate expression was not declared in storeCandidates");
}

function collectIdentityExpressions(input: ValueIdentityInput): readonly ExprRef[] {
  const expressions: ExprRef[] = [];

  for (const target of input.constraints.cellValueTargets) {
    expressions.push(target.value);
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

  expressions.push(...input.storeCandidates);
  return expressions;
}
