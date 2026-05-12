import type { IrOp, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import {
  irOpStorageReads,
  irOpStorageWrites
} from "#x86/ir/model/op-semantics.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export function jitMemoryFaultReason(
  op: IrOp,
  operands: readonly JitOperandBinding[]
): ExitReasonValue | undefined {
  if (irOpStorageReads(op).some((storage) => storageMayAccessMemory(storage, operands))) {
    return ExitReason.MEMORY_READ_FAULT;
  }

  const writesMemory = irOpStorageWrites(op).some((storage) => storageMayAccessMemory(storage, operands));

  if (!writesMemory) {
    return undefined;
  }

  return ExitReason.MEMORY_WRITE_FAULT;
}

export function jitPostInstructionExitReasons(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly ExitReasonValue[] {
  switch (op.op) {
    case "next":
      return instruction.nextMode === "exit" ? [ExitReason.FALLTHROUGH] : [];
    case "jump":
      return [ExitReason.JUMP];
    case "conditionalJump":
      return [ExitReason.BRANCH_TAKEN, ExitReason.BRANCH_NOT_TAKEN];
    case "hostTrap":
      return [ExitReason.HOST_TRAP];
    default:
      return [];
  }
}

export function jitExitConditionValues(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly ValueRef[] {
  if (jitPostInstructionExitReasons(op, instruction).length === 0) {
    return [];
  }

  switch (op.op) {
    case "conditionalJump":
      return [op.condition];
    default:
      return [];
  }
}

export function jitLocalConditionValues(op: IrOp): readonly ValueRef[] {
  switch (op.op) {
    case "value.select":
      return [op.condition];
    default:
      return [];
  }
}

function storageMayAccessMemory(storage: StorageRef, operands: readonly JitOperandBinding[]): boolean {
  switch (storage.kind) {
    case "mem":
      return true;
    case "reg":
      return false;
    case "operand":
      return operands[storage.index]!.kind === "static.mem";
  }
}
