import type {
  IrExprOp,
  IrStorageExpr
} from "#backends/wasm/codegen/expressions.js";
import type { InstructionMetadata } from "#backends/wasm/jit/ir/types.js";
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
  op: IrExprOp,
  instruction: InstructionMetadata
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
  op: IrExprOp,
  instruction: InstructionMetadata
): EffectKind | undefined {
  switch (op.op) {
    case "memory.guard":
      return "memoryGuard";
    case "set":
      return storageAccessIsMemory(op.target, instruction.operands)
        ? "memoryStore"
        : undefined;
    case "let32":
      return op.value.kind === "source" &&
        storageAccessIsMemory(op.value.source, instruction.operands)
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

function storageAccessIsMemory(
  storage: IrStorageExpr,
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
