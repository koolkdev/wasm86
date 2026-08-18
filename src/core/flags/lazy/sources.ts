import type { CompareOperator } from "#compiler/function/values/integer/operators.js";
import type { BitValue } from "#compiler/function/values.js";
import type { OperandWidth } from "#core/types.js";
import type { ConditionCode } from "../conditions.js";
import {
  addStatusFlagValues,
  logicStatusFlagValues,
  subStatusFlagValues,
  type BinaryFlagInput,
  type ResultFlagInput,
  type StatusFlagValues
} from "../values.js";

type AddFlagSource<Width extends OperandWidth> = BinaryFlagInput<Width> &
  Readonly<{
    kind: "add";
    width: Width;
  }>;

type SubFlagSource<Width extends OperandWidth> = BinaryFlagInput<Width> &
  Readonly<{
    kind: "sub";
    width: Width;
  }>;

type LogicFlagSource<Width extends OperandWidth> = ResultFlagInput<Width> &
  Readonly<{
    kind: "logic";
    width: Width;
  }>;

export type SimpleFlagSource<Width extends OperandWidth> =
  AddFlagSource<Width> | SubFlagSource<Width> | LogicFlagSource<Width>;

export function addFlagSource<Width extends OperandWidth>(
  input: BinaryFlagInput<Width>
): AddFlagSource<Width> {
  return {
    kind: "add",
    width: input.left.width,
    ...input
  };
}

export function subFlagSource<Width extends OperandWidth>(
  input: BinaryFlagInput<Width>
): SubFlagSource<Width> {
  return {
    kind: "sub",
    width: input.left.width,
    ...input
  };
}

export function logicFlagSource<Width extends OperandWidth>(
  input: ResultFlagInput<Width>
): LogicFlagSource<Width> {
  return {
    kind: "logic",
    width: input.result.width,
    ...input
  };
}

export function statusFlagValuesForSource<Width extends OperandWidth>(
  source: SimpleFlagSource<Width>,
  input: Readonly<{ undefinedAF: BitValue }>
): StatusFlagValues {
  switch (source.kind) {
    case "add":
      return addStatusFlagValues(source);
    case "sub":
      return subStatusFlagValues(source);
    case "logic":
      return logicStatusFlagValues({
        result: source.result,
        undefinedAF: input.undefinedAF
      });
  }
}

export const simpleFlagSourceConditionOperators: Readonly<
  Record<SimpleFlagSource<OperandWidth>["kind"], Partial<Record<ConditionCode, CompareOperator>>>
> = {
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
