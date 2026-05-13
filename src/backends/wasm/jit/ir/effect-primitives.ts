import type { IrOp, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import {
  irOpStorageReads,
  irOpStorageWrites
} from "#x86/ir/model/op-semantics.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export type JitPostInstructionExitKind =
  | "fallthrough"
  | "jump"
  | "branchTaken"
  | "branchNotTaken"
  | "hostTrap";

export type JitPostInstructionExit = Readonly<{
  kind: JitPostInstructionExitKind;
  exitReason: ExitReasonValue;
}>;

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

export function jitPostInstructionExits(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly JitPostInstructionExit[] {
  switch (op.op) {
    case "next":
      return instruction.nextMode === "exit"
        ? [{ kind: "fallthrough", exitReason: ExitReason.FALLTHROUGH }]
        : [];
    case "jump":
      return [{ kind: "jump", exitReason: ExitReason.JUMP }];
    case "conditionalJump":
      return [
        { kind: "branchTaken", exitReason: ExitReason.JUMP },
        { kind: "branchNotTaken", exitReason: ExitReason.JUMP }
      ];
    case "hostTrap":
      return [{ kind: "hostTrap", exitReason: ExitReason.HOST_TRAP }];
    default:
      return [];
  }
}

export function jitExitConditionValues(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly ValueRef[] {
  if (jitPostInstructionExits(op, instruction).length === 0) {
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
