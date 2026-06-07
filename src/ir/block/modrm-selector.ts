import {
  exprBinary,
  exprConst
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";

export type ModRmSelector = Readonly<{
  kind: "modrm-selector";
  expr: ExprRef;
}>;

export function modRmSelector(expr: ExprRef): ModRmSelector {
  return Object.freeze({
    kind: "modrm-selector",
    expr: canonicalizeExpr(expr)
  });
}

export function modRmBaseSelector(selector: ModRmSelector): ModRmSelector {
  return modRmSelector(exprBinary("and", selector.expr, exprConst(3)));
}

export function modRmHighByteBit(selector: ModRmSelector): ExprRef {
  return canonicalizeExpr(exprBinary("and", selector.expr, exprConst(4)));
}
