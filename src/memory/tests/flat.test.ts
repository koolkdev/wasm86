import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { compileProgram } from "#compiler/compile.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { functionType } from "#compiler/ir/function.js";
import { functionRef } from "#compiler/ir/refs.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { writeBackingBytes } from "#memory/bytes.js";
import { flatMemoryResolution } from "#memory/flat.js";
import {
  guestMemoryResource,
  testExecutionModel
} from "#test/support/execution-model.js";

test("flat byte reads use the flat backing boundary and requested fault intent", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const finalAddress = guestMemoryMinimumByteLength - 1;
  const reader = testExecutionModel.guestMemory.createReader(memory);

  writeBackingBytes(memory, finalAddress, [0xa5]);

  deepStrictEqual(
    reader.readByte(finalAddress, "instructionFetch"),
    { kind: "value", value: 0xa5 }
  );
  deepStrictEqual(
    reader.readByte(
      guestMemoryMinimumByteLength,
      "instructionFetch"
    ),
    {
      kind: "exception",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 16
      }
    }
  );
  deepStrictEqual(
    reader.readByte(guestMemoryMinimumByteLength, "read"),
    {
      kind: "exception",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    }
  );
});

test("generated flat resolution keeps its logical capacity after backing memory grows", () => {
  const builder = new ProgramBuilder(testExecutionModel.resources);
  const type = functionType(["i32", "i32"], ["i32"]);
  const entry = functionRef("memory.flat.classify");
  const exportRef = functionExportRef("memory.flat.classify-export");

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
    ref: exportRef,
    name: "classify",
    target: entry
  });

  const memory = new WebAssembly.Memory({
    initial: testExecutionModel.guestMemory.memoryImport.limits.minPages
  });
  const instance = instantiateCompiledProgram(
    compileProgram(builder.finish()),
    {
      memories: new Map([[guestMemoryResource, memory]]),
      functions: new Map()
    }
  );
  const exported = instance.functionExports.get(exportRef);

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
