import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import {
  rootValuePathScope,
  type JitBranchValuePathScopes,
  type JitControlPathScopesMap
} from "#backends/wasm/jit/codegen/plan/control-paths.js";

export function rootExpressionPathScopes(
  expressionBlock: IrExprBlock
): JitControlPathScopesMap {
  const pathScopes = new Map<number, JitBranchValuePathScopes>();
  const root = rootValuePathScope();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      pathScopes.set(opIndex, {
        taken: root,
        notTaken: root
      });
    }
  }

  return pathScopes;
}
