import {
  compileProgram,
  type CompiledProgram
} from "#compiler/program/compile.js";
import {
  createExecutionModel,
  type ExecutionModel
} from "#execution/model.js";
import { buildInterpreterProgram } from "./program.js";

export function compileInterpreterProgram(
  model: ExecutionModel
): CompiledProgram {
  return compileProgram(buildInterpreterProgram(model));
}

export function encodeInterpreterModule(): Uint8Array<ArrayBuffer> {
  return compileInterpreterProgram(createExecutionModel()).bytes;
}
