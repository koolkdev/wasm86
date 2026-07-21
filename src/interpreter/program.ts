import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { functionExportRef } from "#compiler/program/refs.js";
import type { ExecutionModel } from "#execution/model.js";
import { defineInterpreterRun } from "./run.js";

export const interpreterRunExportName = "run";

export function buildInterpreterProgram(
  model: ExecutionModel
): Program {
  const builder = new ProgramBuilder(model.resources);
  const run = defineInterpreterRun(builder, model);

  builder.exportFunction({
    ref: functionExportRef("interpreter.run-export"),
    name: interpreterRunExportName,
    target: run.ref
  });
  return builder.finish();
}
