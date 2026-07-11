import { assert } from "#common/assert.js";
import type { Value } from "#ir/values.js";
import type { RegName, SegmentRegister } from "#x86/types.js";

export type { Value } from "#ir/values.js";

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type SegmentRef =
  | Readonly<{ kind: "static"; reg: SegmentRegister }>
  | Readonly<{ kind: "dynamic"; index: Value }>;
export type MemRef = Readonly<{
  segment: SegmentRef;
  offset: Value;
}>;
export type MemoryAccessKind = "read" | "write";
export type MemoryAccess<TIntent extends MemoryAccessKind = MemoryAccessKind> = Readonly<{
  kind: "memoryAccess";
  linearAddress: Value;
  byteLength: Value;
  invalid: Value;
  intent: TIntent;
}>;
export type VarRef = Readonly<{ kind: "var"; index: number }>;
export type StorageRef = OperandRef | RegRef | VarRef;

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
