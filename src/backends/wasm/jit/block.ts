import type { IsaDecodedInstruction } from "#x86/isa/decoder/types.js";
import { JitIrBlockBuilder } from "./codegen/emit/block-builder.js";
import type { JitIrBlock } from "./ir/types.js";

export type {
  JitIrBlock,
  JitIrBlockInstruction
} from "./types.js";
export type { JitLinkResolver } from "./codegen/emit/block-emitter.js";
export type { EncodeJitIrBlockOptions } from "./block-module.js";
export { encodeJitIrBlock, jitBlockExportName } from "./block-module.js";
export { staticJitLinkTargets } from "./link-targets.js";

export function buildJitIrBlock(instructions: readonly IsaDecodedInstruction[]): JitIrBlock {
  if (instructions.length === 0) {
    throw new Error("cannot build empty JIT IR block");
  }

  const builder = new JitIrBlockBuilder();

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index]!;
    const isLastInstruction = index === instructions.length - 1;

    builder.appendInstruction(instruction, {
      nextMode: isLastInstruction ? "exit" : "continue"
    });
  }

  return builder.build();
}
