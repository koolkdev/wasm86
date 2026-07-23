import type { ValueId } from "#compiler/ir/values/types.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { StateAccess } from "#core/state/access.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { SwitchArm } from "#compiler/ir/builder/region.js";
import type { OperandWidth } from "#core/types.js";
import type { X86StatusFlag } from "../definitions.js";
import { flagStateFields } from "../layout.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "./encoding.js";
import { statusFlagValuesForSource } from "./sources.js";

export const statusFlagResolverType = functionType(
  [],
  ["i32"]
);

export type StatusFlagResolverFamily = FunctionFamily<X86StatusFlag>;

export function createStatusFlagResolvers(
  stateAccess: StateAccess
): StatusFlagResolverFamily {
  return new FunctionFamily<X86StatusFlag>({
    type: statusFlagResolverType,
    effects: (flag) => ({
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
  fn: FunctionBuilder,
  stateAccess: StateAccess
): void {
  const state = stateAccess.bind(fn.region);
  const lazyKind = state.readField(flagStateFields.lazyKind);
  const lazyA = state.readField(flagStateFields.lazyA);
  const lazyB = state.readField(flagStateFields.lazyB);
  const concreteValue = state.readField(
    flagStateFields.concrete[flag],
    { kind: "unsigned", bounds: fitsUnsigned(1) }
  );

  const result = fn.region.switch(
    lazyKind,
    [
      concreteArm(concreteValue),
      ...([8, 16, 32] as const).flatMap((width) => [
        binaryArm(flag, "add", width, lazyA, lazyB),
        binaryArm(flag, "sub", width, lazyA, lazyB),
        logicArm(flag, width, lazyA)
      ])
    ],
    (arm) => arm.values.unreachable()
  );

  fn.return([result]);
}

function concreteArm(concreteValue: ValueId): SwitchArm {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0),
    build: () => concreteValue
  };
}

function binaryArm(
  flag: X86StatusFlag,
  kind: "add" | "sub",
  width: OperandWidth,
  left: ValueId,
  right: ValueId
): SwitchArm {
  return {
    match: lazyFlagsKindByte(
      kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB,
      width
    ),
    build: (arm) => statusFlagValuesForSource(arm.values, {
      kind,
      width,
      left,
      right,
      result: arm.values.binary(kind, left, right)
    }, { undefinedAF: arm.values.const(0) })[flag]
  };
}

function logicArm(
  flag: X86StatusFlag,
  width: OperandWidth,
  result: ValueId
): SwitchArm {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, width),
    build: (arm) => statusFlagValuesForSource(arm.values, {
      kind: "logic",
      width,
      result
    }, { undefinedAF: arm.values.const(0) })[flag]
  };
}
