export type BinaryOperator =
  | "add"
  | "sub"
  | "xor"
  | "or"
  | "and"
  | "shl"
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

export type UnaryOperator =
  | "extend8_s"
  | "extend16_s"
  | "popcnt";

export const signedComparePredicates: ReadonlySet<CompareOperator> = new Set([
  "lt_s",
  "le_s",
  "gt_s",
  "ge_s"
]);
