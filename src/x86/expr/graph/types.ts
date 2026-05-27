import type { ExprRef } from "../types.js";

export type ExprNodeId = number;

export type ExprNode = Readonly<{
  id: ExprNodeId;
  expr: ExprRef;
  children: readonly ExprNode[];
}>;

export type ExprGraph = Readonly<{
  node(expr: ExprRef): ExprNode;
  get(id: ExprNodeId): ExprNode;
}>;

export type ExprOrder = readonly ExprNode[];
export type ExprIdentity = ExprGraph;

export type ExprGraphAnalysis = Readonly<{
  order: ExprOrder;
  identity: ExprIdentity;
}>;
