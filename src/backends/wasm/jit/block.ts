export type {
  JitIrBlock,
  JitIrInstruction,
  InstructionMetadata
} from "./ir/types.js";
export type {
  BlockExpressions,
  BlockExprOp
} from "./ir/block-expressions.js";
export type {
  JitBoundExprBlock,
  JitBoundExprOp,
  JitMemoryGuardExprOp,
  JitNextExprOp,
  JitHostTrapExprOp
} from "./ir/bound-expressions.js";
export type {
  BlockAnalysis,
  BlockEffectAnalysis
} from "./analysis/block.js";
export type { JitLinkResolver } from "./codegen/emit/control-effects.js";
export type {
  EncodeJitBlockOptions,
  JitBlockModulePlan
} from "./block-module.js";
export { encodeJitBlock, jitBlockExportName } from "./block-module.js";
export { buildBlock } from "./ir/block-builder.js";
export {
  buildBlockExpressions,
  preparedOpsFromBlockExpressions
} from "./ir/block-expressions.js";
export { validateBlock } from "./ir/validate.js";
export { analyzeBlock } from "./analysis/block.js";
export { planJitCodegen } from "./codegen/plan/plan.js";
