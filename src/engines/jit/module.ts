import {
  compileProgram,
  type CompiledProgram
} from "#compiler/program/compile.js";
import type { ExecutionModel } from "#execution/model.js";
import { u32 } from "#core/numeric.js";
import type { IrBlock } from "#ir/block.js";
import type { JitLinkLayout } from "./compiled-blocks/module-link-table.js";
import { buildJitProgram, jitBlockLinkTargets } from "./program.js";

export {
  jitBlockExportName,
  jitLinkTableImportName
} from "./program.js";

export type JitBlock = Readonly<{
  entryEip: number;
  ir: IrBlock;
}>;

export type JitModuleOptions = Readonly<{
  linkLayout?: JitLinkLayout;
}>;

export function jitModuleLinkTargets(blocks: readonly JitBlock[]): readonly number[] {
  const internalEips = new Set(blocks.map((block) => u32(block.entryEip)));
  const targets: number[] = [];
  const seen = new Set<number>();

  for (const block of blocks) {
    for (const targetEip of jitBlockLinkTargets(block.ir)) {
      if (!internalEips.has(targetEip) && !seen.has(targetEip)) {
        targets.push(targetEip);
        seen.add(targetEip);
      }
    }
  }

  return targets;
}

export function encodeJitModule(
  model: ExecutionModel,
  blocks: readonly JitBlock[],
  options: JitModuleOptions = {}
): Uint8Array<ArrayBuffer> {
  return compileJitProgram(model, blocks, options).bytes;
}

export function compileJitProgram(
  model: ExecutionModel,
  blocks: readonly JitBlock[],
  options: JitModuleOptions = {}
): CompiledProgram {
  return compileProgram(
    buildJitProgram(model, blocks, options.linkLayout)
  );
}
