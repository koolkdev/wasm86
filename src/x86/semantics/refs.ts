import { assert } from "#common/assert.js";
import type { RegName } from "#x86/types.js";

declare const valueBrand: unique symbol;

export type Value = number & { readonly [valueBrand]: "x86-semantic-value" };

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type MemRef = Readonly<{ kind: "mem"; address: Value }>;
export type StorageRef = OperandRef | RegRef | MemRef;

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

export function toStorageRef(value: StorageInput): StorageRef {
  return value;
}
