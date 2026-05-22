import type {
  ExitKind,
  ExitSnapshot
} from "./exits.js";

export type BlockProgress = Readonly<{
  instructionCountDelta: number;
}>;

export function addBlockProgress(
  left: BlockProgress,
  right: BlockProgress
): BlockProgress {
  return {
    instructionCountDelta: left.instructionCountDelta +
      right.instructionCountDelta
  };
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
