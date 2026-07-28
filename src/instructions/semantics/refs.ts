import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { RegName, SegmentRegister } from "#core/types.js";

export type Value = ValueId;

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type SegmentRef =
  Readonly<{ kind: "static"; reg: SegmentRegister }> | Readonly<{ kind: "dynamic"; index: Value }>;
export type MemRef = Readonly<{
  segment: SegmentRef;
  offset: Value;
}>;
export type StorageRef = OperandRef | RegRef | VariableRef<"i32">;

export type OperandInput = OperandRef;
export type StorageInput = StorageRef;
export type ValueInput = Value;
export type TargetInput = ValueInput;

export function operand(index: number): OperandRef {
  assert(
    Number.isInteger(index) && index >= 0,
    `operand index must be a non-negative integer, got ${index}`
  );
  return { kind: "operand", index };
}

export function reg(reg: RegName): RegRef {
  return { kind: "reg", reg };
}

export function toStorageRef(value: StorageInput): StorageRef {
  return value;
}
