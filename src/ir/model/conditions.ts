import type { ConditionCode } from "./types.js";
import type { FlagName } from "./flags.js";

export type FlagBoolExpr =
  | Readonly<{ kind: "flag"; flag: FlagName }>
  | Readonly<{ kind: "not"; value: FlagBoolExpr }>
  | Readonly<{ kind: "and"; a: FlagBoolExpr; b: FlagBoolExpr }>
  | Readonly<{ kind: "or"; a: FlagBoolExpr; b: FlagBoolExpr }>
  | Readonly<{ kind: "xor"; a: FlagBoolExpr; b: FlagBoolExpr }>;

export type ConditionSemantics = Readonly<{
  reads: readonly FlagName[];
  expr: FlagBoolExpr;
}>;

export const f = (flag: FlagName): FlagBoolExpr => ({ kind: "flag", flag });
export const not = (value: FlagBoolExpr): FlagBoolExpr => ({ kind: "not", value });
export const band = (a: FlagBoolExpr, b: FlagBoolExpr): FlagBoolExpr => ({ kind: "and", a, b });
export const bor = (a: FlagBoolExpr, b: FlagBoolExpr): FlagBoolExpr => ({ kind: "or", a, b });
export const bxor = (a: FlagBoolExpr, b: FlagBoolExpr): FlagBoolExpr => ({ kind: "xor", a, b });

export const CONDITIONS = {
  O: { reads: ["OF"], expr: f("OF") },
  NO: { reads: ["OF"], expr: not(f("OF")) },

  B: { reads: ["CF"], expr: f("CF") },
  AE: { reads: ["CF"], expr: not(f("CF")) },

  E: { reads: ["ZF"], expr: f("ZF") },
  NE: { reads: ["ZF"], expr: not(f("ZF")) },

  BE: { reads: ["CF", "ZF"], expr: bor(f("CF"), f("ZF")) },
  A: { reads: ["CF", "ZF"], expr: band(not(f("CF")), not(f("ZF"))) },

  S: { reads: ["SF"], expr: f("SF") },
  NS: { reads: ["SF"], expr: not(f("SF")) },

  P: { reads: ["PF"], expr: f("PF") },
  NP: { reads: ["PF"], expr: not(f("PF")) },

  L: { reads: ["SF", "OF"], expr: bxor(f("SF"), f("OF")) },
  GE: { reads: ["SF", "OF"], expr: not(bxor(f("SF"), f("OF"))) },

  LE: { reads: ["ZF", "SF", "OF"], expr: bor(f("ZF"), bxor(f("SF"), f("OF"))) },
  G: {
    reads: ["ZF", "SF", "OF"],
    expr: band(not(f("ZF")), not(bxor(f("SF"), f("OF"))))
  }
} as const satisfies Record<ConditionCode, ConditionSemantics>;
