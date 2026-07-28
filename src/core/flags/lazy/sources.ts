import type { ConditionCode } from "../conditions.js";
import {
  addStatusFlagValues,
  logicStatusFlagValues,
  subStatusFlagValues,
  type StatusFlagValues
} from "../values.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { OperandWidth } from "#core/types.js";

type AddFlagSource = Readonly<{
  kind: "add";
  width: OperandWidth;
  left: ValueId;
  right: ValueId;
  result: ValueId;
}>;

type SubFlagSource = Readonly<{
  kind: "sub";
  width: OperandWidth;
  left: ValueId;
  right: ValueId;
  result: ValueId;
}>;

type LogicFlagSource = Readonly<{
  kind: "logic";
  width: OperandWidth;
  result: ValueId;
}>;

export type SimpleFlagSource = AddFlagSource | SubFlagSource | LogicFlagSource;

export function addFlagSource(input: Omit<AddFlagSource, "kind">): AddFlagSource {
  return { kind: "add", ...input };
}

export function subFlagSource(input: Omit<SubFlagSource, "kind">): SubFlagSource {
  return { kind: "sub", ...input };
}

export function logicFlagSource(input: Omit<LogicFlagSource, "kind">): LogicFlagSource {
  return { kind: "logic", ...input };
}

export function statusFlagValuesForSource(
  values: ValueBuilder,
  source: SimpleFlagSource,
  input: Readonly<{ undefinedAF: ValueId }>
): StatusFlagValues {
  switch (source.kind) {
    case "add":
      return addStatusFlagValues(values, {
        width: source.width,
        left: values.truncate(source.width, source.left),
        right: values.truncate(source.width, source.right),
        result: values.truncate(source.width, source.result)
      });
    case "sub":
      return subStatusFlagValues(values, {
        width: source.width,
        left: values.truncate(source.width, source.left),
        right: values.truncate(source.width, source.right),
        result: values.truncate(source.width, source.result)
      });
    case "logic":
      return logicStatusFlagValues(values, {
        width: source.width,
        result: values.truncate(source.width, source.result),
        undefinedAF: input.undefinedAF
      });
  }
}

export const simpleFlagSourceConditionOperators: Readonly<
  Record<SimpleFlagSource["kind"], Partial<Record<ConditionCode, CompareOperator>>>
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
