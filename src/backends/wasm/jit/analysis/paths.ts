import type { IrExpressionSourceMap } from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";

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

export function branchPathId(
  instructionIndex: number,
  opIndex: number,
  arm: BranchArm
): PathId {
  return `branch:${instructionIndex}:${opIndex}:${arm}`;
}

export function buildInstructionPaths(
  instruction: JitInstruction,
  instructionIndex: number
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while planning paths: ${instructionIndex}:${opIndex}`);
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

export function buildExpressionPaths(
  sourcePaths: PathMap,
  sourceMap: IrExpressionSourceMap,
  instructionIndex: number
): PathMap {
  const expressionPaths = new Map<number, BranchPaths>();

  for (const [sourceOpIndex, paths] of sourcePaths) {
    const placements = sourceMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [];
    const emittedPlacements = placements.filter((placement) => placement.kind === "emittedOp");
    const [placement] = emittedPlacements;

    if (placement === undefined || emittedPlacements.length !== 1) {
      throw new Error(
        `could not map JIT source path op to expression op: ${instructionIndex}:${sourceOpIndex}`
      );
    }

    expressionPaths.set(placement.expressionOpIndex, paths);
  }

  return expressionPaths;
}

export function pathsEqual(left: Path, right: Path): boolean {
  return left.id === right.id;
}
