import { assert } from "#common/assert.js";
import type { Value } from "#ir/values.js";
import type { RegName } from "#x86/types.js";

export type { Value } from "#ir/values.js";

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type MemRef = Readonly<{ kind: "mem"; address: Value }>;
export type VarRef = Readonly<{ kind: "var"; index: number }>;
export type StorageRef = OperandRef | RegRef | MemRef | VarRef;

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

export function mem(address: ValueInput): MemRef {
  return { kind: "mem", address };
}

export function semanticVar(index: number): VarRef {
  assert(
    Number.isInteger(index) && index >= 0,
    `semantic var index must be a non-negative integer, got ${index}`
  );
  return { kind: "var", index };
}

export function toStorageRef(value: StorageInput): StorageRef {
  return value;
}
