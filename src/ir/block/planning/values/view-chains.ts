import type { ExprNode } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";

export type InputExprNode = ExprNode & { readonly expr: Extract<ExprRef, { kind: "input" }> };

export function singleInputViewChainSource(node: ExprNode): InputExprNode | undefined {
  let current = singleInputViewChild(node);

  if (current === undefined) {
    return undefined;
  }

  for (;;) {
    const next = singleInputViewChild(current);

    if (next === undefined) {
      break;
    }

    current = next;
  }

  return current.expr.kind === "input"
    ? current as InputExprNode
    : undefined;
}

function singleInputViewChild(node: ExprNode): ExprNode | undefined {
  const expr = node.expr;

  switch (expr.kind) {
    case "unary":
      return isUnaryViewOp(expr.op) ? node.children[0]! : undefined;
    case "project":
    case "bits":
      return node.children[0]!;
    case "const":
    case "input":
    case "binary":
    case "select":
    case "insertBits":
    case "compare":
      return undefined;
  }
}

function isUnaryViewOp(op: Extract<ExprRef, { kind: "unary" }>["op"]): boolean {
  switch (op) {
    case "extend8_s":
    case "extend16_s":
      return true;
    case "popcnt":
      return false;
  }
}
