import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import type { SwitchArm } from "#compiler/function/builder/region.js";
import { functionType } from "#compiler/function/type.js";
import {
  Integer,
  integer,
  unreachable,
  type BitValue,
  type I32Value
} from "#compiler/function/values.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { StateAccess } from "#core/state/access.js";
import type { OperandWidth } from "#core/types.js";
import type { X86StatusFlag } from "../definitions.js";
import { flagStateFields } from "../layout.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "./encoding.js";
import {
  addFlagSource,
  logicFlagSource,
  statusFlagValuesForSource,
  subFlagSource
} from "./sources.js";

export const statusFlagResolverType = functionType([], [Integer[1]]);

export type StatusFlagResolverFamily = FunctionFamily<X86StatusFlag, typeof statusFlagResolverType>;

export function createStatusFlagResolvers(stateAccess: StateAccess): StatusFlagResolverFamily {
  return new FunctionFamily({
    type: statusFlagResolverType,
    effects: (flag: X86StatusFlag) => ({
      reads: [
        stateAccess.fieldEffect(flagStateFields.lazyKind),
        stateAccess.fieldEffect(flagStateFields.lazyA),
        stateAccess.fieldEffect(flagStateFields.lazyB),
        stateAccess.fieldEffect(flagStateFields.concrete[flag])
      ],
      writes: []
    }),
    id: (flag) => `core.flags.resolve.${flag}`,
    build: (flag, fn) => buildStatusFlagResolver(flag, fn, stateAccess)
  });
}

function buildStatusFlagResolver(
  flag: X86StatusFlag,
  fn: FunctionBuilder<typeof statusFlagResolverType>,
  stateAccess: StateAccess
): void {
  const state = stateAccess.forRegion(fn.region);
  const lazyKind = state.readField(flagStateFields.lazyKind);
  const lazyA = state.readField(flagStateFields.lazyA);
  const lazyB = state.readField(flagStateFields.lazyB);
  const concreteValue = state.readField(flagStateFields.concrete[flag]);

  const result = fn.region.switch(
    lazyKind,
    [
      concreteArm(concreteValue),
      ...sourceArms(flag, 8, lazyA, lazyB),
      ...sourceArms(flag, 16, lazyA, lazyB),
      ...sourceArms(flag, 32, lazyA, lazyB)
    ],
    () => unreachable(1)
  );

  fn.return([result]);
}

function concreteArm(concreteValue: BitValue): SwitchArm<BitValue> {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0),
    build: () => concreteValue
  };
}

function sourceArms<Width extends OperandWidth>(
  flag: X86StatusFlag,
  width: Width,
  left: I32Value,
  right: I32Value
): readonly SwitchArm<BitValue>[] {
  return [
    binaryArm(flag, "add", width, left, right),
    binaryArm(flag, "sub", width, left, right),
    logicArm(flag, width, left)
  ];
}

function binaryArm<Width extends OperandWidth>(
  flag: X86StatusFlag,
  kind: "add" | "sub",
  width: Width,
  left: I32Value,
  right: I32Value
): SwitchArm<BitValue> {
  return {
    match: lazyFlagsKindByte(kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB, width),
    build: () => {
      const leftValue = left.truncate(width);
      const rightValue = right.truncate(width);
      const result = kind === "add" ? leftValue.add(rightValue) : leftValue.sub(rightValue);
      const source =
        kind === "add"
          ? addFlagSource({
              left: leftValue,
              right: rightValue,
              result
            })
          : subFlagSource({
              left: leftValue,
              right: rightValue,
              result
            });

      return statusFlagValuesForSource(source, { undefinedAF: integer(1, 0) })[flag];
    }
  };
}

function logicArm<Width extends OperandWidth>(
  flag: X86StatusFlag,
  width: Width,
  result: I32Value
): SwitchArm<BitValue> {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, width),
    build: () =>
      statusFlagValuesForSource(logicFlagSource({ result: result.truncate(width) }), {
        undefinedAF: integer(1, 0)
      })[flag]
  };
}
