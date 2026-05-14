import type { IrOp, ValueRef } from "#x86/ir/model/types.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
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

export function jitMemoryFaultReason(op: IrOp): ExitReasonValue | undefined {
  if (op.op === "memory.guard") {
    return op.access === "read"
      ? ExitReason.MEMORY_READ_FAULT
      : ExitReason.MEMORY_WRITE_FAULT;
  }

  return undefined;
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
