import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { SemanticBuildContext, SemanticsBuilder } from "#x86/semantics/builder.js";
import type { StorageInput, ValueInput } from "#x86/semantics/refs.js";
import type { OperandWidth } from "#x86/types.js";

export function guardStorageRead(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["read"]);
}

export function guardStorageWrite(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["write"]);
}

export function guardStorageReadWrite(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["read", "write"]);
}

function guardStorageAccesses(
  s: SemanticsBuilder,
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
    s.memoryGuard(address, byteLength, access);
  }
}

function memoryGuardAddress(
  s: SemanticsBuilder,
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
      return undefined;
  }
}

function byteLengthForWidth(width: OperandWidth): number {
  return width / 8;
}
