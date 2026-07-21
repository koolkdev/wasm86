import { strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { compileProgram } from "#compiler/program/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  functionExportRef,
  functionRef
} from "#compiler/program/refs.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  flatMemoryResolution
} from "#memory/flat.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { programImportModuleName } from "#compiler/program/imports.js";

test("one flat fragment keeps its fixed capacity when backing memory grows", async () => {
  const builder = new ProgramBuilder(testExecutionModel.resources);
  const type = functionType(["i32", "i32"], ["i32"]);
  const entry = functionRef("memory.flat-e2e.classify");

  builder.defineFunction({
    ref: entry,
    type,
    effects: { reads: [], writes: [] }
  }, (fn) => {
    const start = fn.parameters[0];
    const byteLength = fn.parameters[1];

    assert(start !== undefined, "flat classifier start parameter is missing");
    assert(byteLength !== undefined, "flat classifier length parameter is missing");
    const resolution = flatMemoryResolution(
      fn.values,
      { start, byteLength },
      "read"
    );

    fn.return([resolution.fault.condition]);
  });
  builder.exportFunction({
    ref: functionExportRef("memory.flat-e2e.classify-export"),
    name: "classify",
    target: entry
  });

  const memory = new WebAssembly.Memory({
    initial: testExecutionModel.guestMemory.memoryImport.limits.minPages
  });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(compileProgram(builder.finish()).bytes),
    {
      [programImportModuleName]: {
        [testExecutionModel.guestMemory.memoryImport.name]: memory
      }
    }
  );
  const exported = instance.exports.classify;

  if (typeof exported !== "function") {
    throw new Error("flat classifier export is missing");
  }
  const classify = exported as (start: number, byteLength: number) => number;

  strictEqual(classify(guestMemoryMinimumByteLength - 1, 1), 0);
  strictEqual(classify(guestMemoryMinimumByteLength - 1, 2), 1);
  strictEqual(classify(guestMemoryMinimumByteLength, 1), 1);
  strictEqual(classify(0, 0), 1);
  strictEqual(classify(-1, 0), 1);

  memory.grow(1);

  strictEqual(classify(guestMemoryMinimumByteLength, 1), 1);
  strictEqual(classify(guestMemoryMinimumByteLength * 2 - 1, 1), 1);
});
