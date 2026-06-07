import type { ExprRef } from "./types.js";

export type ExprChildRole =
  | "value"
  | "left"
  | "right"
  | "condition"
  | "whenTrue"
  | "whenFalse"
  | "base";

export type ExprChildSlot = Readonly<{
  role: ExprChildRole;
  expr: ExprRef;
}>;

export function exprChildSlots(expr: ExprRef): readonly ExprChildSlot[] {
  switch (expr.kind) {
    case "const":
    case "input":
      return [];
    case "binary":
    case "compare":
      return [
        { role: "left", expr: expr.left },
        { role: "right", expr: expr.right }
      ];
    case "unary":
    case "project":
    case "bits":
      return [
        { role: "value", expr: expr.value }
      ];
    case "select":
      return [
        { role: "condition", expr: expr.condition },
        { role: "whenTrue", expr: expr.whenTrue },
        { role: "whenFalse", expr: expr.whenFalse }
      ];
    case "insertBits":
      return [
        { role: "base", expr: expr.base },
        { role: "value", expr: expr.value }
      ];
  }
}

export function exprChildren(expr: ExprRef): readonly ExprRef[] {
  return exprChildSlots(expr).map((slot) => slot.expr);
}
