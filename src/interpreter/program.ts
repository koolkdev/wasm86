import { ProgramBuilder } from "#compiler/program/builder.js";
import type { Program } from "#compiler/program/program.js";
import { compileProgram, type CompiledProgram } from "#compiler/compile.js";
import { functionExportRef, type FunctionExportRef } from "#compiler/program/exports.js";
import type { ExecutionModel } from "#execution/model.js";
import { defineInterpreterRun } from "./run.js";

const interpreterRunExportName = "run";
const interpreterRunExport = functionExportRef("interpreter.run-export");

export type InterpreterProgram = Readonly<{
  program: Program;
  entry: FunctionExportRef;
}>;

export type CompiledInterpreter = Readonly<{
  program: CompiledProgram;
  entry: FunctionExportRef;
}>;

export function buildInterpreterProgram(model: ExecutionModel): InterpreterProgram {
  const builder = new ProgramBuilder(model.resources);
  const run = defineInterpreterRun(builder, model);

  builder.exportFunction({
    ref: interpreterRunExport,
    name: interpreterRunExportName,
    target: run.ref
  });
  return {
    program: builder.finish(),
    entry: interpreterRunExport
  };
}

export function compileInterpreterProgram(model: ExecutionModel): CompiledInterpreter {
  const interpreter = buildInterpreterProgram(model);

  return {
    program: compileProgram(interpreter.program),
    entry: interpreter.entry
  };
}
