import {
  BindingResolver,
  memBinding,
  type OperandBinding,
  type StorageBinding
} from "#ir/block/bindings/resolver.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  StorageRef,
  ValueRef
} from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";

export type ResolvedStorageRead =
  | Readonly<{ kind: "value"; value: ExprRef }>
  | Readonly<{ kind: "storage"; binding: StorageBinding }>;

export function resolveStorageRead(
  resolver: BindingResolver,
  source: StorageRef,
  accessWidth: OperandWidth,
  value: (value: ValueRef) => ExprRef
): ResolvedStorageRead {
  if (source.kind === "operand") {
    return storageReadFromOperand(resolver.operand(source.index));
  }

  return Object.freeze({
    kind: "storage",
    binding: storageBinding(resolver, source, accessWidth, value)
  });
}

export function resolveStorageWrite(
  resolver: BindingResolver,
  target: StorageRef,
  accessWidth: OperandWidth,
  value: (value: ValueRef) => ExprRef
): StorageBinding {
  if (target.kind === "operand") {
    const binding = resolver.operand(target.index);

    if (binding.kind === "value") {
      throw new Error(`operand ${target.index} is a value binding, not storage`);
    }

    return binding;
  }

  return storageBinding(resolver, target, accessWidth, value);
}

function storageReadFromOperand(binding: OperandBinding): ResolvedStorageRead {
  return binding.kind === "value"
    ? Object.freeze({ kind: "value", value: binding.value })
    : Object.freeze({ kind: "storage", binding });
}

function storageBinding(
  resolver: BindingResolver,
  source: Exclude<StorageRef, { kind: "operand" }>,
  accessWidth: OperandWidth,
  value: (value: ValueRef) => ExprRef
): StorageBinding {
  if (source.kind === "mem") {
    return memBinding(value(source.address), accessWidth);
  }

  return resolver.storage(source, accessWidth);
}
