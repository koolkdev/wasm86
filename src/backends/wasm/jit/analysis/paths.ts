import type { JitBoundExprBlock } from "#backends/wasm/jit/ir/bound-expressions.js";

export type PathId = string;

export type Path = Readonly<{
  kind: "path";
  id: PathId;
  debugLabel?: string;
}>;

export type BranchArm = "taken" | "notTaken";

export type BranchPaths = Readonly<Record<BranchArm, Path>>;
export type PathMap = ReadonlyMap<number, BranchPaths>;

export function rootPath(): Path {
  return { kind: "path", id: rootPathId() };
}

export function rootPathId(): PathId {
  return "root";
}

export function branchPath(
  opIndex: number,
  arm: BranchArm
): Path {
  return {
    kind: "path",
    id: branchPathId(opIndex, arm),
    debugLabel: arm
  };
}

function branchPathId(
  opIndex: number,
  arm: BranchArm
): PathId {
  return `branch:${opIndex}:${arm}`;
}

export function buildExpressionPaths(
  expressions: JitBoundExprBlock
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (const [opIndex, op] of expressions.entries()) {
    if (op.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: branchPath(opIndex, "taken"),
        notTaken: branchPath(opIndex, "notTaken")
      });
    }
  }

  return paths;
}

export function pathsEqual(left: Path, right: Path): boolean {
  return left.id === right.id;
}
