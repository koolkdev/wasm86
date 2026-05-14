import type {
  IrBuilder,
  IrMemoryAccessKind,
  SemanticBuildContext,
  StorageInput
} from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export function guardStorageRead(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccess(s, context, storage, byteLengthForWidth(width), "read");
}

export function guardStorageWrite(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  guardStorageAccess(s, context, storage, byteLengthForWidth(width), "write");
}

export function guardStorageReadWrite(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): void {
  // Temporary until Wasm interpreter/JIT lower memory.guard explicitly.
  if (!context.memoryGuards) {
    return;
  }

  const byteLength = byteLengthForWidth(width);

  switch (storage.kind) {
    case "mem":
      s.memoryGuard(storage.address, byteLength, "read");
      s.memoryGuard(storage.address, byteLength, "write");
      return;
    case "operand":
      if (context.operandInfo(storage).storage === "mem") {
        const address = s.address(storage);

        s.memoryGuard(address, byteLength, "read");
        s.memoryGuard(address, byteLength, "write");
      }
      return;
    case "reg":
      return;
  }
}

function guardStorageAccess(
  s: IrBuilder,
  context: SemanticBuildContext,
  storage: StorageInput,
  byteLength: number,
  access: IrMemoryAccessKind
): void {
  // Temporary until Wasm interpreter/JIT lower memory.guard explicitly.
  if (!context.memoryGuards) {
    return;
  }

  switch (storage.kind) {
    case "mem":
      s.memoryGuard(storage.address, byteLength, access);
      return;
    case "operand":
      if (context.operandInfo(storage).storage === "mem") {
        s.memoryGuard(s.address(storage), byteLength, access);
      }
      return;
    case "reg":
      return;
  }
}

function byteLengthForWidth(width: OperandWidth): number {
  return width / 8;
}
