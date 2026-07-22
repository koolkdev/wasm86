import { assert } from "#common/assert.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import { decodeExit } from "#cpu/exit.js";
import type { RunStop } from "#cpu/cpu.js";
import type { ExecutionModel } from "#execution/model.js";
import type { CompiledJitArtifact } from "#engines/jit/compile.js";
import {
  decodeTransfer,
  type LegacyTransfer
} from "#engines/jit/legacy-transfer.js";
import { jitBlockExportName } from "#engines/jit/program.js";

export type JitArtifactRun = Readonly<{
  exit: LegacyTransfer | RunStop;
}>;

export type JitArtifactHandle = Readonly<{
  run(): JitArtifactRun;
}>;

export type InstantiateJitArtifactOptions = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
}>;

export function instantiateJitArtifact(
  model: ExecutionModel,
  artifact: CompiledJitArtifact,
  options: InstantiateJitArtifactOptions
): JitArtifactHandle {
  const memories = new Map<ResourceRef, WebAssembly.Memory>([
    [model.cpuState.resource, options.cpuStateMemory],
    [model.guestMemory.resource, options.guestMemory]
  ]);
  const instance = instantiateCompiledProgram(artifact.program, memories);
  const exportName = jitBlockExportName(artifact.entryEip);
  const exported = artifact.program.functionExports.find(
    (candidate) => candidate.name === exportName
  );

  assert(exported !== undefined, `missing compiled JIT entry export '${exportName}'`);
  const value = instance.functionExports.get(exported.ref);

  assert(typeof value === "function", `compiled JIT entry '${exportName}' is not callable`);
  const run = value as () => unknown;

  return {
    run: () => decodeArtifactRun(run())
  };
}

function decodeArtifactRun(encodedExit: unknown): JitArtifactRun {
  if (typeof encodedExit !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof encodedExit}`);
  }

  return {
    exit: decodeTransfer(encodedExit) ?? decodeExit(encodedExit)
  };
}
