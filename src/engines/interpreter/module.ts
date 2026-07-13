import { encodeProgram } from "#compiler/program/encode.js";
import type { InterpreterHandler } from "./handlers.js";
import { buildInterpreterProgram } from "./program.js";

export type InterpreterModule = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  // One entry per emitted handler body, in emission order.
  handlers: readonly InterpreterHandler[];
  // Opcode lengths with a declared shared rm-decode helper.
  rmDecodeHelpers: readonly number[];
}>;

export function encodeInterpreterModule(): InterpreterModule {
  const built = buildInterpreterProgram();
  const bytes = encodeProgram(built.program);

  return {
    bytes,
    handlers: built.handlers,
    rmDecodeHelpers: built.rmDecodeHelpers
  };
}
