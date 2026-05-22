import type { JitBoundExprOp } from "#backends/wasm/jit/ir/bound-expressions.js";
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
  op: JitBoundExprOp,
  isFinalOp: boolean
): readonly ExitKind[] {
  switch (op.op) {
    case "memory.guard":
      return [op.access === "read" ? "memoryReadFault" : "memoryWriteFault"];
    case "next":
      return isFinalOp
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
  op: JitBoundExprOp,
  isFinalOp: boolean
): EffectKind | undefined {
  switch (op.op) {
    case "memory.guard":
      return "memoryGuard";
    case "set":
      return op.target.kind === "mem"
        ? "memoryStore"
        : undefined;
    case "let32":
      return op.value.kind === "source" &&
        op.value.source.kind === "mem"
        ? "memoryLoad"
        : undefined;
    case "jump":
      return "jump";
    case "conditionalJump":
      return "branch";
    case "hostTrap":
      return "hostTrap";
    case "next":
      return isFinalOp
        ? "fallthrough"
        : undefined;
    default:
      return undefined;
  }
}
