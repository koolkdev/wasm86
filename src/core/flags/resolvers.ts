import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { FunctionBuilder } from "#ir/function.js";
import type { SwitchArm } from "#ir/region-builder.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { OperandWidth } from "#core/types.js";
import type { X86StatusFlag } from "./definitions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "./state.js";
import { statusFlagValuesForSource } from "./values.js";

export const statusFlagResolverType = functionType(
  ["i32", "i32", "i32", "i32"],
  ["i32"]
);

export const statusFlagResolvers = new FunctionFamily<X86StatusFlag>({
  type: statusFlagResolverType,
  effects: () => ({ reads: [], writes: [] }),
  id: (flag) => `core.flags.resolve.${flag}`,
  build: (flag, fn) => buildStatusFlagResolver(flag, fn)
});

function buildStatusFlagResolver(flag: X86StatusFlag, fn: FunctionBuilder): void {
  const [lazyKind, lazyA, lazyB, concreteValue] = fn.parameters;

  assert(lazyKind !== undefined, "status-flag resolver is missing its lazy-kind parameter");
  assert(lazyA !== undefined, "status-flag resolver is missing its lazy A parameter");
  assert(lazyB !== undefined, "status-flag resolver is missing its lazy B parameter");
  assert(concreteValue !== undefined, "status-flag resolver is missing its concrete parameter");

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
    build: (arm) => statusFlagValuesForSource(valueTableFlagOps(arm.values), {
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
    build: (arm) => statusFlagValuesForSource(valueTableFlagOps(arm.values), {
      kind: "logic",
      width,
      result
    }, { undefinedAF: arm.values.const(0) })[flag]
  };
}
