import { throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { RmDecodeHelpers } from "#engines/interpreter/decode.js";
import {
  InterpreterLocals,
  withModRmScratch,
  withRmAddressScratch
} from "#engines/interpreter/locals.js";

test("raw R/M calls reject opcode lengths absent from the call requirements", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const scratch = new WasmLocalScratchAllocator(body);
  const locals = new InterpreterLocals(body);
  const helpers = new RmDecodeHelpers([], { base: 0, offset: 1, cursor: 2 });

  withModRmScratch(scratch, (modRm) => {
    withRmAddressScratch(scratch, (rmAddress) => {
      throws(
        () => helpers.emitMemoryAddressDecode({ body, scratch, locals, modRm, rmAddress }, 3),
        /unlisted interpreter R\/M opcode length: 3/
      );
    });
  });
  scratch.assertClear();
});
