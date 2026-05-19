import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { StorageRef } from "#x86/ir/model/types.js";
import type { RegisterAlias } from "#x86/isa/types.js";

export type OperandResolver = Readonly<{
  canInlineGet(source: StorageRef): boolean;
  storageMayAlias(write: StorageRef, read: StorageRef): boolean;
}>;

export function createOperandResolver(
  operands: readonly JitOperandBinding[]
): OperandResolver {
  return {
    canInlineGet: (source) => canInlineGet(operands, source),
    storageMayAlias: (write, read) => storageMayAlias(operands, write, read)
  };
}

function canInlineGet(
  operands: readonly JitOperandBinding[],
  source: StorageRef
): boolean {
  switch (source.kind) {
    case "reg":
      return true;
    case "mem":
      return false;
    case "operand": {
      const binding = operandBinding(operands, source.index);

      return binding.kind !== "static.mem";
    }
  }
}

function storageMayAlias(
  operands: readonly JitOperandBinding[],
  write: StorageRef,
  read: StorageRef
): boolean {
  if (write.kind === "mem" || read.kind === "mem") {
    return write.kind === "mem" && read.kind === "mem";
  }

  const writeAlias = storageRegisterAlias(operands, write);
  const readAlias = storageRegisterAlias(operands, read);

  return writeAlias !== undefined &&
    readAlias !== undefined &&
    registerAliasesMayOverlap(writeAlias, readAlias);
}

function storageRegisterAlias(
  operands: readonly JitOperandBinding[],
  storage: StorageRef
): RegisterAlias | undefined {
  switch (storage.kind) {
    case "reg":
      return { name: storage.reg, base: storage.reg, bitOffset: 0, width: 32 };
    case "mem":
      return undefined;
    case "operand": {
      const binding = operandBinding(operands, storage.index);

      return binding.kind === "static.reg" ? binding.alias : undefined;
    }
  }
}

function operandBinding(
  operands: readonly JitOperandBinding[],
  index: number
): JitOperandBinding {
  const binding = operands[index];

  if (binding === undefined) {
    throw new Error(`missing JIT operand binding: ${index}`);
  }

  return binding;
}

function registerAliasesMayOverlap(
  left: RegisterAlias,
  right: RegisterAlias
): boolean {
  return left.base === right.base &&
    left.bitOffset < right.bitOffset + right.width &&
    right.bitOffset < left.bitOffset + left.width;
}
