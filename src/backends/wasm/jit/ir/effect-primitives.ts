import type { StorageRef, ValueRef } from "#x86/ir/model/types.js";
import {
  jitIrOpStorageReads,
  jitIrOpStorageWrites
} from "#backends/wasm/jit/ir/semantics.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";

export function jitMemoryFaultReason(
  op: JitIrOp,
  operands: readonly JitOperandBinding[]
): ExitReasonValue | undefined {
  if (jitIrOpStorageReads(op).some((storage) => storageMayAccessMemory(storage, operands))) {
    return ExitReason.MEMORY_READ_FAULT;
  }

  const writesMemory = jitIrOpStorageWrites(op).some((storage) => storageMayAccessMemory(storage, operands));

  if (!writesMemory) {
    return undefined;
  }

  if (op.op === "set.if") {
    throw new Error("JIT conditional memory writes are not supported by exit analysis");
  }

  return ExitReason.MEMORY_WRITE_FAULT;
}

export function jitPostInstructionExitReasons(
  op: JitIrOp,
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
  op: JitIrOp,
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

export function jitLocalConditionValues(op: JitIrOp): readonly ValueRef[] {
  switch (op.op) {
    case "set.if":
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
