import type { ConditionCode } from "./conditions.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type { OperandWidth } from "../types.js";

type AddFlagSource<TValue extends number = number> = Readonly<{
  kind: "add";
  width: OperandWidth;
  left: TValue;
  right: TValue;
  result: TValue;
}>;

type SubFlagSource<TValue extends number = number> = Readonly<{
  kind: "sub";
  width: OperandWidth;
  left: TValue;
  right: TValue;
  result: TValue;
}>;

type LogicFlagSource<TValue extends number = number> = Readonly<{
  kind: "logic";
  width: OperandWidth;
  result: TValue;
}>;

export type SimpleFlagSource<TValue extends number = number> =
  | AddFlagSource<TValue>
  | SubFlagSource<TValue>
  | LogicFlagSource<TValue>;

export const simpleFlagSourceConditionOperators: Readonly<Record<
  SimpleFlagSource["kind"],
  Partial<Record<ConditionCode, CompareOperator>>
>> = {
  add: {},
  sub: {
    E: "eq",
    NE: "ne",
    B: "lt_u",
    AE: "ge_u",
    BE: "le_u",
    A: "gt_u",
    L: "lt_s",
    GE: "ge_s",
    LE: "le_s",
    G: "gt_s"
  },
  logic: {
    E: "eq",
    NE: "ne"
  }
};
