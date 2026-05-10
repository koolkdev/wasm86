import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { validateJitIrBlock } from "#backends/wasm/jit/ir/validate.js";
import type { JitOptimizationPass, JitOptimizationPassRun, JitPassContext } from "./pass.js";
import { runJitOptimizationPasses } from "./pass.js";
import { collectJitPassStats, type JitPassStatsByName } from "./stats.js";
import { localDcePass } from "./passes/local-dce.js";
import { flagDcePass } from "./passes/flag-dce.js";
import { registerValuePropagationPass } from "./passes/register-value-propagation.js";

export const jitIrOptimizationPasses = [
  localDcePass,
  flagDcePass,
  localDcePass,
  registerValuePropagationPass,
  localDcePass
] as const satisfies readonly JitOptimizationPass[];

export type JitIrOptimizationPassName = typeof jitIrOptimizationPasses[number]["name"];

export const jitIrOptimizationPassOrder = [
  "localDce",
  "flagDce",
  "localDce",
  "registerValuePropagation",
  "localDce"
] as const satisfies readonly JitIrOptimizationPassName[];

export type JitIrOptimizationPipelineResult = Readonly<{
  block: JitIrBlock;
  passResults: readonly JitOptimizationPassRun<JitIrOptimizationPassName>[];
  stats: JitPassStatsByName<JitIrOptimizationPassName>;
}>;

export function runJitIrOptimizationPipeline(
  block: JitIrBlock,
  context: JitPassContext = {}
): JitIrOptimizationPipelineResult {
  const result = runJitOptimizationPasses(block, jitIrOptimizationPasses, context);

  validateJitIrBlock(result.block);

  return {
    block: result.block,
    passResults: result.passes,
    stats: collectJitPassStats(result.passes)
  };
}
