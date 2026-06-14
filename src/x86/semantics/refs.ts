import { assert } from "#common/assert.js";
import type { RegName } from "#x86/types.js";

export type VarId = number;

export type ValueType = "i32";

export type VarRef = Readonly<{ kind: "var"; id: VarId }>;
export type ConstValueRef = Readonly<{ kind: "const"; type: ValueType; value: number }>;
export type NextEipRef = Readonly<{ kind: "nextEip" }>;
export type ValueRef = VarRef | ConstValueRef | NextEipRef;

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type MemRef = Readonly<{ kind: "mem"; address: ValueRef }>;
export type StorageRef = OperandRef | RegRef | MemRef;

export type OperandInput = OperandRef;
export type StorageInput = StorageRef;
export type ValueInput = ValueRef | number;
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
  return { kind: "mem", address: toValueRef(address) };
}

export function varRef(id: number): VarRef {
  assert(
    Number.isInteger(id) && id >= 0,
    `value ref id must be a non-negative integer, got ${id}`
  );
  return { kind: "var", id };
}

export function const32(value: number): ConstValueRef {
  return { kind: "const", type: "i32", value: value >>> 0 };
}

export function nextEip(): NextEipRef {
  return { kind: "nextEip" };
}

export function toStorageRef(value: StorageInput): StorageRef {
  return value;
}

export function toValueRef(value: ValueInput): ValueRef {
  return typeof value === "number" ? const32(value) : value;
}
