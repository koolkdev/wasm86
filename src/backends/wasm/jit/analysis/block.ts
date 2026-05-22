import {
  preparedOpsFromBlockExpressions,
  type BlockExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import {
  analyzeBlockEffects,
  timelineSnapshotPointsForExpressions,
  type BlockEffectAnalysis
} from "./effects.js";
import { LoadResultRegistry } from "./load-result.js";
import { buildExpressionPaths } from "./paths.js";
import { buildTimeline } from "./timeline-builder.js";
import type { Timeline } from "./timeline-types.js";
import {
  addBlockProgress,
  type BlockProgress
} from "./block-progress.js";

export type { BlockEffectAnalysis } from "./effects.js";

export type BlockAnalysis = Readonly<{
  expressions: BlockExpressions;
  timeline: Timeline;
  effectAnalysis: BlockEffectAnalysis;
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
  const effectAnalysis = analyzeBlockEffects({
    expressions: blockExpressions,
    timeline,
    expressionPaths,
    progress: entryProgress
  });

  return {
    expressions: blockExpressions,
    timeline,
    effectAnalysis,
    progress: addBlockProgress(entryProgress, blockExpressions.progress)
  };
}
