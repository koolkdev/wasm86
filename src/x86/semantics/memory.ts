import type {
  IrBuilder,
  IrMemoryAccessKind,
  SemanticBuildContext,
  StorageInput,
  ValueInput
} from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";

export function guardStorageRead(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["read"]);
}

export function guardStorageWrite(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["write"]);
}

export function guardStorageReadWrite(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccesses(s, context, storage, byteLengthForWidth(width), ["read", "write"]);
}

function guardStorageAccesses(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  byteLength: number,
  accesses: readonly IrMemoryAccessKind[]
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
  s: IrBuilder,
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
          return s.address(storage);
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
