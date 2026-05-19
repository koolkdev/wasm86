import type { IrOp } from "#x86/ir/model/types.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type {
  ExitKind,
  ExitSnapshot
} from "./exits.js";

export type InstructionProgress = Readonly<{
  instructionCountDelta: number;
}>;

export function instructionDeltaAfterOp(
  op: IrOp,
  instruction: JitInstruction
): number {
  return op.op === "next" && instruction.nextMode === "continue"
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
