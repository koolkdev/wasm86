export type {
  JitBlock,
  JitInstruction
} from "./ir/types.js";
export type { JitLinkResolver } from "./codegen/emit/control-exits.js";
export type { EncodeJitBlockOptions } from "./block-module.js";
export { encodeJitBlock, jitBlockExportName } from "./block-module.js";
export { staticJitLinkTargets } from "./link-targets.js";
export { buildBlock } from "./ir/block-builder.js";
