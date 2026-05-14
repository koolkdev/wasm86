import type {
  IrExpressionSourceMap,
  IrExpressionSourcePlacement
} from "#backends/wasm/codegen/expressions.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

export type JitControlPathId = string;

export type JitValuePathScope = Readonly<{
  kind: "path";
  id: JitControlPathId;
  debugLabel?: string;
}>;

export type JitBranchArm = "taken" | "notTaken";

export type JitBranchValuePathScopes = Readonly<Record<JitBranchArm, JitValuePathScope>>;
export type JitControlPathScopesMap = ReadonlyMap<number, JitBranchValuePathScopes>;

export function rootValuePathScope(): JitValuePathScope {
  return { kind: "path", id: rootControlPathId() };
}

export function rootControlPathId(): JitControlPathId {
  return "root";
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

export function buildJitInstructionControlPathScopes(
  instruction: JitIrBlockInstruction,
  instructionIndex: number
): JitControlPathScopesMap {
  const pathScopes = new Map<number, JitBranchValuePathScopes>();

  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while planning control path scopes: ${instructionIndex}:${opIndex}`);
    }

    if (op.op === "conditionalJump") {
      pathScopes.set(opIndex, {
        taken: branchValuePathScope(instructionIndex, opIndex, "taken"),
        notTaken: branchValuePathScope(instructionIndex, opIndex, "notTaken")
      });
    }
  }

  return pathScopes;
}

export function buildJitExpressionControlPathScopes(
  sourcePathScopes: JitControlPathScopesMap,
  sourceMap: IrExpressionSourceMap,
  instructionIndex: number
): JitControlPathScopesMap {
  const expressionPathScopes = new Map<number, JitBranchValuePathScopes>();

  for (const [sourceOpIndex, pathScopes] of sourcePathScopes) {
    const expressionOpIndex = requiredSourceEmittedExpressionOpIndex(
      sourceMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [],
      instructionIndex,
      sourceOpIndex
    );

    expressionPathScopes.set(expressionOpIndex, pathScopes);
  }

  return expressionPathScopes;
}

export function jitValuePathScopesEqual(
  left: JitValuePathScope,
  right: JitValuePathScope
): boolean {
  return left.id === right.id;
}

function requiredSourceEmittedExpressionOpIndex(
  placements: readonly IrExpressionSourcePlacement[],
  instructionIndex: number,
  sourceOpIndex: number
): number {
  const emittedPlacements = placements.filter((placement) => placement.kind === "emittedOp");
  const [placement] = emittedPlacements;

  if (placement === undefined || emittedPlacements.length !== 1) {
    throw new Error(
      `could not map JIT source control path op to expression op: ${instructionIndex}:${sourceOpIndex}`
    );
  }

  return placement.expressionOpIndex;
}
