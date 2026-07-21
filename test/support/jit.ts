import { buildIrBlock as buildIrBlockForModel } from "#engines/jit/action-compiler.js";
import {
  encodeJitModule as encodeJitModuleForModel,
  type JitBlock,
  type JitModuleOptions
} from "#engines/jit/module.js";
import { buildJitProgram as buildJitProgramForModel } from "#engines/jit/program.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import type { IrBlock } from "#ir/block.js";
import {
  testExecutionModel,
  testInstructionConstruction
} from "./execution-model.js";

export function buildIrBlock(
  instructions: readonly IsaDecodedInstruction[]
): IrBlock {
  return buildIrBlockForModel(testInstructionConstruction, instructions);
}

export function encodeJitModule(
  blocks: readonly JitBlock[],
  options: JitModuleOptions = {}
): Uint8Array<ArrayBuffer> {
  return encodeJitModuleForModel(testExecutionModel, blocks, options);
}

export function buildJitProgram(
  sourceBlocks: Parameters<typeof buildJitProgramForModel>[1],
  linkLayout: Parameters<typeof buildJitProgramForModel>[2]
): ReturnType<typeof buildJitProgramForModel> {
  return buildJitProgramForModel(
    testExecutionModel,
    sourceBlocks,
    linkLayout
  );
}
