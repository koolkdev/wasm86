import type { IrExprBlock } from "#wasm/codegen/expressions.js";
import {
  rootPath,
  type BranchPaths,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";

export function rootExpressionPaths(
  expressionBlock: IrExprBlock
): PathMap {
  const paths = new Map<number, BranchPaths>();
  const root = rootPath();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: root,
        notTaken: root
      });
    }
  }

  return paths;
}
