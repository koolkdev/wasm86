import type { IrOp, ValueRef } from "#x86/ir/model/types.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export type JitOpExitKind =
  | "memoryReadFault"
  | "memoryWriteFault"
  | "fallthrough"
  | "jump"
  | "branchTaken"
  | "branchNotTaken"
  | "hostTrap";

export function jitOpExits(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly JitOpExitKind[] {
  switch (op.op) {
    case "memory.guard":
      return [op.access === "read" ? "memoryReadFault" : "memoryWriteFault"];
    case "next":
      return instruction.nextMode === "exit"
        ? ["fallthrough"]
        : [];
    case "jump":
      return ["jump"];
    case "conditionalJump":
      return [
        "branchTaken",
        "branchNotTaken"
      ];
    case "hostTrap":
      return ["hostTrap"];
    default:
      return [];
  }
}

export function jitOpExitReason(exit: JitOpExitKind): ExitReasonValue {
  switch (exit) {
    case "memoryReadFault":
      return ExitReason.MEMORY_READ_FAULT;
    case "memoryWriteFault":
      return ExitReason.MEMORY_WRITE_FAULT;
    case "fallthrough":
      return ExitReason.FALLTHROUGH;
    case "jump":
    case "branchTaken":
    case "branchNotTaken":
      return ExitReason.JUMP;
    case "hostTrap":
      return ExitReason.HOST_TRAP;
  }
}

export function jitExitConditionValues(
  op: IrOp,
  instruction: JitIrBlockInstruction
): readonly ValueRef[] {
  if (jitOpExits(op, instruction).length === 0) {
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
