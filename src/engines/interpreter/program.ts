import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import { exportRef, signatureRef } from "#compiler/program/refs.js";
import { buildExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStatusFlagResolvers
} from "#cpu/state.js";
import { statusFlagResolverType } from "#core/flags/lazy/resolvers.js";
import { guestMemoryAccess } from "#memory/access.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { guestMemoryResource } from "#memory/resource.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { defineInterpreterRun } from "./run.js";

export function buildInterpreterProgram(): Program {
  const builder = new ProgramBuilder();
  const runSignature = builder.signature({
    ref: signatureRef("interpreter.run-signature"),
    type: functionType([], ["i64"])
  });

  // Resolver members are discovered from instruction calls when the program
  // closes; their shared function type must be declared beforehand.
  builder.signature({
    ref: signatureRef("interpreter.status-flag-resolver-signature"),
    type: statusFlagResolverType
  });

  builder.importMemory({
    ref: cpuState.resource,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  builder.importMemory({
    ref: guestMemoryResource,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });
  const run = defineInterpreterRun(builder, runSignature, {
    state: cpuState,
    statusFlagResolvers: cpuStatusFlagResolvers,
    memory: {
      resource: guestMemoryResource,
      access: guestMemoryAccess
    },
    instructionCount: instructionCountField,
    instructionLimit: instructionLimitField,
    buildExit
  });

  builder.exportFunction({
    ref: exportRef("interpreter.run-export"),
    name: wasmBlockExportName,
    target: run.ref
  });
  return builder.finish();
}
