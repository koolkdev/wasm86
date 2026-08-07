export type BinaryArithmeticOperator =
  "add" | "sub" | "mul" | "div_s" | "div_u" | "rem_s" | "rem_u";

export type BinaryBitwiseOperator =
  "xor" | "or" | "and" | "shl" | "rotl" | "rotr" | "shr_s" | "shr_u";

export type BinaryOperator = BinaryArithmeticOperator | BinaryBitwiseOperator;

export type BitCountOperator = "popcnt" | "ctz" | "clz";

export type CompareOperator =
  "eq" | "ne" | "lt_u" | "le_u" | "gt_u" | "ge_u" | "lt_s" | "le_s" | "gt_s" | "ge_s";

export function compareIsSigned(operator: CompareOperator): boolean {
  switch (operator) {
    case "lt_s":
    case "le_s":
    case "gt_s":
    case "ge_s":
      return true;
    case "eq":
    case "ne":
    case "lt_u":
    case "le_u":
    case "gt_u":
    case "ge_u":
      return false;
  }
}
