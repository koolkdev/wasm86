import type { ExprRef } from "./types.js";

export function exprChildren(expr: ExprRef): readonly ExprRef[] {
  switch (expr.kind) {
    case "const":
    case "input":
      return [];
    case "binary":
    case "compare":
      return [expr.left, expr.right];
    case "unary":
    case "project":
    case "bits":
      return [expr.value];
    case "select":
      return [expr.condition, expr.whenTrue, expr.whenFalse];
    case "insertBits":
      return [expr.base, expr.value];
  }
}
