import type { JitBoundExprOp } from "#backends/wasm/jit/ir/bound-expressions.js";
import type {
  ExitKind,
  ExitSnapshot
} from "./exits.js";

export type InstructionProgress = Readonly<{
  instructionCountDelta: number;
}>;

export function instructionDeltaAfterOp(
  op: JitBoundExprOp,
  isFinalInstruction: boolean
): number {
  return op.op === "next" && !isFinalInstruction
    ? 1
    : 0;
}

export function snapshotForExit(
  kind: ExitKind,
  snapshot: ExitSnapshot
): ExitSnapshot {
  return exitCommitsInstruction(kind)
    ? {
        ...snapshot,
        progress: {
          instructionCountDelta: snapshot.progress.instructionCountDelta + 1
        }
      }
    : snapshot;
}

export function exitCommitsInstruction(kind: ExitKind): boolean {
  switch (kind) {
    case "fallthrough":
    case "jump":
    case "branchTaken":
    case "branchNotTaken":
    case "hostTrap":
      return true;
    case "memoryReadFault":
    case "memoryWriteFault":
      return false;
  }
}
