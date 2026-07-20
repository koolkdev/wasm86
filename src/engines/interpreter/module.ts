import { encodeProgram } from "#compiler/program/encode.js";
import { buildInterpreterProgram } from "./program.js";

export function encodeInterpreterModule(): Uint8Array<ArrayBuffer> {
  return encodeProgram(buildInterpreterProgram());
}
