import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";

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
  instructionIndex: number,
  opIndex: number,
  arm: BranchArm
): Path {
  return {
    kind: "path",
    id: branchPathId(instructionIndex, opIndex, arm),
    debugLabel: arm
  };
}

function branchPathId(
  instructionIndex: number,
  opIndex: number,
  arm: BranchArm
): PathId {
  return `branch:${instructionIndex}:${opIndex}:${arm}`;
}

export function buildExpressionPaths(
  expressions: IrExprBlock,
  instructionIndex: number
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (let opIndex = 0; opIndex < expressions.length; opIndex += 1) {
    const op = expressions[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT expression op while planning paths: ${instructionIndex}:${opIndex}`);
    }

    if (op.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: branchPath(instructionIndex, opIndex, "taken"),
        notTaken: branchPath(instructionIndex, opIndex, "notTaken")
      });
    }
  }

  return paths;
}

export function pathsEqual(left: Path, right: Path): boolean {
  return left.id === right.id;
}
