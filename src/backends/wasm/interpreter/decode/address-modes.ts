import type { IrBlock, IrOp, SemanticOperandInfo, StorageRef } from "#x86/ir/model/types.js";

export type InterpreterAddressMode = "eager" | "deferred";

export function planInterpreterAddressModes(
  program: IrBlock,
  operandInfo: readonly SemanticOperandInfo[]
): readonly InterpreterAddressMode[] {
  const modes = operandInfo.map((): InterpreterAddressMode => "eager");
  const seenAddress = new Set<number>();
  let hasRegisterWrite = false;

  for (const op of program) {
    for (const operandIndex of addressUseOperands(op, operandInfo)) {
      if (hasRegisterWrite && !seenAddress.has(operandIndex)) {
        modes[operandIndex] = "deferred";
      }

      seenAddress.add(operandIndex);
    }

    if (opMayWriteRegister(op, operandInfo)) {
      hasRegisterWrite = true;
    }
  }

  return modes;
}

function addressUseOperands(op: IrOp, operandInfo: readonly SemanticOperandInfo[]): readonly number[] {
  switch (op.op) {
    case "address":
      return [op.operand.index];
    case "get":
      return storageAddressOperand(op.source, operandInfo);
    case "set":
      return storageAddressOperand(op.target, operandInfo);
    case "memory.guard":
    case "value.const":
    case "value.binary":
    case "value.unary":
    case "value.select":
    case "flags.set":
    case "flags.condition":
    case "next":
    case "jump":
    case "conditionalJump":
    case "hostTrap":
      return [];
  }
}

function storageAddressOperand(
  storage: StorageRef,
  operandInfo: readonly SemanticOperandInfo[]
): readonly number[] {
  if (storage.kind !== "operand" || !operandMayUseMemory(operandInfo[storage.index])) {
    return [];
  }

  return [storage.index];
}

function opMayWriteRegister(op: IrOp, operandInfo: readonly SemanticOperandInfo[]): boolean {
  if (op.op !== "set") {
    return false;
  }

  switch (op.target.kind) {
    case "reg":
      return true;
    case "operand":
      return operandMayWriteRegister(operandInfo[op.target.index]);
    case "mem":
      return false;
  }
}

function operandMayUseMemory(info: SemanticOperandInfo | undefined): boolean {
  return info?.storage === "mem" || info?.storage === "regOrMem";
}

function operandMayWriteRegister(info: SemanticOperandInfo | undefined): boolean {
  return info?.storage === "reg" || info?.storage === "regOrMem";
}
