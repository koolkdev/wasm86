import {
  preparedOpsFromBlockExpressions,
  type BlockExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import {
  analyzeBlockRuntime,
  timelineSnapshotPointsForExpressions,
  type BlockRuntimeAnalysis
} from "./runtime.js";
import { LoadResultRegistry } from "./load-result.js";
import { buildExpressionPaths } from "./paths.js";
import { buildTimeline } from "./timeline-builder.js";
import type { Timeline } from "./timeline-types.js";
import {
  addBlockProgress,
  type BlockProgress
} from "./block-progress.js";

export type { BlockRuntimeAnalysis } from "./runtime.js";

export type BlockAnalysis = Readonly<{
  expressions: BlockExpressions;
  timeline: Timeline;
  runtime: BlockRuntimeAnalysis;
  progress: BlockProgress;
}>;

export function analyzeBlock(blockExpressions: BlockExpressions): BlockAnalysis {
  const entryProgress = {
    instructionCountDelta: 0
  };
  const loadResultRegistry = new LoadResultRegistry();
  const expressionOps = preparedOpsFromBlockExpressions(blockExpressions);
  const expressionPaths = buildExpressionPaths(blockExpressions);
  const timeline = buildTimeline({
    expressions: expressionOps,
    snapshotPoints: timelineSnapshotPointsForExpressions(blockExpressions),
    loadResultRegistry
  });
  const runtime = analyzeBlockRuntime({
    expressions: blockExpressions,
    timeline,
    expressionPaths,
    progress: entryProgress
  });

  return {
    expressions: blockExpressions,
    timeline,
    runtime,
    progress: addBlockProgress(entryProgress, blockExpressions.progress)
  };
}
