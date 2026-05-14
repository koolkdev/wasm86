export type JitControlPathId = string;

export type JitValuePathScope =
  | Readonly<{ kind: "shared" }>
  | Readonly<{
      kind: "path";
      id: JitControlPathId;
      debugLabel?: string;
    }>;

export type JitBranchArm = "taken" | "notTaken";

export function sharedValuePathScope(): JitValuePathScope {
  return { kind: "shared" };
}

export function branchValuePathScope(
  instructionIndex: number,
  opIndex: number,
  arm: JitBranchArm
): JitValuePathScope {
  return {
    kind: "path",
    id: branchControlPathId(instructionIndex, opIndex, arm),
    debugLabel: arm
  };
}

export function branchControlPathId(
  instructionIndex: number,
  opIndex: number,
  arm: JitBranchArm
): JitControlPathId {
  return `branch:${instructionIndex}:${opIndex}:${arm}`;
}

export function jitValuePathScopesEqual(
  left: JitValuePathScope,
  right: JitValuePathScope
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return left.kind === "shared" ||
    (right.kind === "path" && left.id === right.id);
}
