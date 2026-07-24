import { compileProgram, type CompiledProgram } from "#compiler/compile.js";
import type { FunctionExportRef } from "#compiler/program/exports.js";
import type { ExecutionModel } from "#execution/model.js";
import {
  snapshotInstructionBytes,
  type InstructionByteSnapshot
} from "./instruction-snapshot.js";
import { decodeJitBlock } from "./decode-block.js";
import {
  jitSnapshotRequestByteLength,
  type JitBlockPolicy
} from "./policy.js";
import { buildJitProgram } from "./program.js";

export type CompiledJitArtifact = Readonly<{
  program: CompiledProgram;
  entry: FunctionExportRef;
  entryEip: number;
}>;

export function compileJitFromMemory(
  input: Readonly<{
    memory: WebAssembly.Memory;
    start: number;
    policy: JitBlockPolicy;
    model: ExecutionModel;
  }>
): CompiledJitArtifact {
  const byteLength = jitSnapshotRequestByteLength(input.policy);
  const reader = input.model.memory.bindHost({
    ram: input.memory
  }).reader;
  const snapshot = snapshotInstructionBytes(
    reader,
    { linearStart: input.start, byteLength }
  );

  return compileJitArtifact({
    snapshot,
    policy: input.policy,
    model: input.model
  });
}

export function compileJitArtifact(
  input: Readonly<{
    snapshot: InstructionByteSnapshot;
    policy: JitBlockPolicy;
    model: ExecutionModel;
  }>
): CompiledJitArtifact {
  const { snapshot, policy, model } = input;
  const start = snapshot.linearStart;
  const decoded = decodeJitBlock(snapshot, policy);
  const built = buildJitProgram(model, decoded);

  return {
    program: compileProgram(built.program),
    entry: built.entry,
    entryEip: start
  };
}
