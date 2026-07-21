import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { exportRef } from "#compiler/program/refs.js";
import { buildExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStatusFlagResolvers
} from "#cpu/state.js";
import { guestMemoryAccess } from "#memory/access.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { guestMemoryResource } from "#memory/resource.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { defineInterpreterRun } from "./run.js";

export function buildInterpreterProgram(): Program {
  const builder = new ProgramBuilder();

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
  const run = defineInterpreterRun(builder, {
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
