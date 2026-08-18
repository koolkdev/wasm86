import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { Integer as IntegerType, type Integer, type I32Value } from "#compiler/function/values.js";
import { registerAlias } from "#core/registers.js";
import type {
  OperandWidth,
  RegName,
  RegisterNameForWidth,
  RegisterWidth,
  SegmentRegister
} from "#core/types.js";

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef<Name extends RegName = RegName> = Readonly<{
  kind: "reg";
  reg: Name;
  width: RegisterWidth<Name>;
}>;
export type SegmentRef =
  | Readonly<{ kind: "static"; reg: SegmentRegister }>
  | Readonly<{ kind: "dynamic"; index: Integer<8> }>;
export type MemRef = Readonly<{
  segment: SegmentRef;
  offset: I32Value;
}>;
export type RegRefForWidth<Width extends OperandWidth> = Readonly<{
  kind: "reg";
  reg: RegisterNameForWidth<Width>;
  width: Width;
}>;
export type SemanticVar = VariableRef<(typeof IntegerType)[32]>;
export type StorageRef = OperandRef | RegRef | SemanticVar;

export function operand(index: number): OperandRef {
  assert(
    Number.isInteger(index) && index >= 0,
    `operand index must be a non-negative integer, got ${index}`
  );
  return { kind: "operand", index };
}

export function reg<Name extends RegName>(name: Name): RegRef<Name> {
  return {
    kind: "reg",
    reg: name,
    width: registerAlias(name).width
  };
}
