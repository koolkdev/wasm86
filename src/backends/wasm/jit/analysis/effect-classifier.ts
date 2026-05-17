import type { IrOp, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { ExitKind } from "./exits.js";

export type EffectKind =
  | "memoryGuard"
  | "memoryStore"
  | "memoryLoad"
  | "jump"
  | "branch"
  | "hostTrap"
  | "fallthrough";

export function classifyExits(
  op: IrOp,
  instruction: JitInstruction
): readonly ExitKind[] {
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

export function classifyEffect(
  op: IrOp,
  instruction: JitInstruction
): EffectKind | undefined {
  switch (op.op) {
    case "memory.guard":
      return "memoryGuard";
    case "set":
      return storageAccessIsMemory(op.target, instruction.operands)
        ? "memoryStore"
        : undefined;
    case "get":
      return storageAccessIsMemory(op.source, instruction.operands)
        ? "memoryLoad"
        : undefined;
    case "jump":
      return "jump";
    case "conditionalJump":
      return "branch";
    case "hostTrap":
      return "hostTrap";
    case "next":
      return instruction.nextMode === "exit"
        ? "fallthrough"
        : undefined;
    default:
      return undefined;
  }
}

export function exitConditionValues(
  op: IrOp,
  instruction: JitInstruction
): readonly ValueRef[] {
  if (classifyExits(op, instruction).length === 0) {
    return [];
  }

  switch (op.op) {
    case "conditionalJump":
      return [op.condition];
    default:
      return [];
  }
}

export function localConditionValues(op: IrOp): readonly ValueRef[] {
  switch (op.op) {
    case "value.select":
      return [op.condition];
    default:
      return [];
  }
}

function storageAccessIsMemory(
  storage: StorageRef,
  operands: readonly JitOperandBinding[]
): boolean {
  switch (storage.kind) {
    case "mem":
      return true;
    case "operand":
      return operands[storage.index]?.kind === "static.mem";
    case "reg":
      return false;
  }
}
