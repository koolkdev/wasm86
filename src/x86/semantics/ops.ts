export type BinaryOperator =
  | "add"
  | "sub"
  | "mul"
  | "div_s"
  | "div_u"
  | "rem_s"
  | "rem_u"
  | "xor"
  | "or"
  | "and"
  | "shl"
  | "rotl"
  | "rotr"
  | "shr_s"
  | "shr_u";

export type CompareOperator =
  | "eq"
  | "ne"
  | "lt_u"
  | "le_u"
  | "gt_u"
  | "ge_u"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s";

export type UnaryOperator = "popcnt" | "ctz" | "clz";

export const signedComparePredicates: ReadonlySet<CompareOperator> = new Set([
  "lt_s",
  "le_s",
  "gt_s",
  "ge_s"
]);
