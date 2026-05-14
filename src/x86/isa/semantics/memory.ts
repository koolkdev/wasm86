import type {
  IrBuilder,
  IrMemoryAccessKind,
  OperandRef,
  SemanticBuildContext,
  SemanticOperandStorageKind,
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
      switch (operandStorageForGuard(context, storage)) {
        case "mem": {
          const address = s.address(storage);

          s.memoryGuard(address, byteLength, "read");
          s.memoryGuard(address, byteLength, "write");
          return;
        }
        case "regOrMem": {
          const address = s.address(storage);

          s.memoryGuard(address, byteLength, "read");
          s.memoryGuard(address, byteLength, "write");
          return;
        }
        case "reg":
        case "imm":
        case "relTarget":
          return;
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
  if (!context.memoryGuards) {
    return;
  }

  switch (storage.kind) {
    case "mem":
      s.memoryGuard(storage.address, byteLength, access);
      return;
    case "operand":
      switch (operandStorageForGuard(context, storage)) {
        case "mem":
        case "regOrMem":
          s.memoryGuard(s.address(storage), byteLength, access);
          return;
        case "reg":
        case "imm":
        case "relTarget":
          return;
      }
      return;
    case "reg":
      return;
  }
}

function operandStorageForGuard(
  context: SemanticBuildContext,
  storage: OperandRef
): Exclude<SemanticOperandStorageKind, "unknown"> {
  const kind = context.operandInfo(storage).storage;

  if (kind === "unknown") {
    throw new Error(`memory guard requires storage metadata for operand ${storage.index}`);
  }

  return kind;
}

function byteLengthForWidth(width: OperandWidth): number {
  return width / 8;
}
