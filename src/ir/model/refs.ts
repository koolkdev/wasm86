import type { RegName } from "#x86/types.js";
import type {
  IrConstValueRef,
  MemRef,
  NextEipRef,
  OperandRef,
  RegRef,
  StorageInput,
  StorageRef,
  ValueInput,
  ValueRef,
  VarRef
} from "./types.js";

export function operand(index: number): OperandRef {
  assertOperandIndex(index);
  return { kind: "operand", index };
}

export function reg(reg: RegName): RegRef {
  return { kind: "reg", reg };
}

export function mem(address: ValueInput): MemRef {
  return { kind: "mem", address: toValueRef(address) };
}

export function irVar(id: number): VarRef {
  assertVarId(id);
  return { kind: "var", id };
}

export function const32(value: number): IrConstValueRef {
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

function assertOperandIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`operand index must be a non-negative integer, got ${index}`);
  }
}

function assertVarId(id: number): void {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`IR var id must be a non-negative integer, got ${id}`);
  }
}
