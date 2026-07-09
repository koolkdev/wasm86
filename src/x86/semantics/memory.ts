import { assert } from "#common/assert.js";
import type { Values } from "#ir/values.js";
import type { MemoryAccessKind, SemanticBuildContext, SemanticOps } from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, ValueInput } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";

export type ResolvedOperandStorage = "reg" | "mem";

export function resolvedOperandStorage(
  context: SemanticBuildContext,
  operand: OperandRef
): ResolvedOperandStorage {
  const storage = context.operandInfo(operand).storage;

  switch (storage) {
    case "reg":
      return "reg";
    case "mem":
      return "mem";
    case "regOrMem":
      assert(false, "operand storage must be resolved to register or memory");
    case "imm":
    case "relTarget":
      assert(false, `operand storage cannot be ${storage}`);
  }
}

export function guardStorageRead(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, v, context, storage, byteLengthForWidth(width), ["read"]);
}

export function guardStorageWrite(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, v, context, storage, byteLengthForWidth(width), ["write"]);
}

export function guardStorageReadWrite(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, v, context, storage, byteLengthForWidth(width), ["read", "write"]);
}

function guardStorageAccesses(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  byteLength: number,
  accesses: readonly MemoryAccessKind[]
): void {
  const address = memoryGuardAddress(s, context, storage);

  if (address === undefined) {
    return;
  }

  for (const access of accesses) {
    s.memoryGuard(address, v.const(byteLength), access);
  }
}

function memoryGuardAddress(
  s: SemanticOps,
  context: SemanticBuildContext,
  storage: StorageInput
): ValueInput | undefined {
  switch (storage.kind) {
    case "mem":
      return storage.address;
    case "operand":
      switch (context.operandInfo(storage).storage) {
        case "mem":
        case "regOrMem":
          return s.linearAddress(storage);
        case "reg":
        case "imm":
        case "relTarget":
          return undefined;
      }
      return undefined;
    case "reg":
    case "var":
      return undefined;
  }
}

function byteLengthForWidth(width: OperandWidth): number {
  return width / 8;
}
